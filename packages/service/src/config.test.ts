import { describe, expect, it } from "vitest";
import { parseServiceConfig, ServiceConfigError } from "./config.js";
import { loadServiceConfig } from "./node-config.js";

const HASH = "a".repeat(64);
const KEYS = JSON.stringify([{ name: "ops", sha256: HASH, scopes: ["read"] }]);

function issues(run: () => unknown): { field: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceConfigError) return [...error.issues];
    throw error;
  }
  throw new Error("expected the configuration to be refused");
}

describe("parseServiceConfig", () => {
  it("parses a valid environment and applies only the documented defaults", () => {
    const config = parseServiceConfig({
      env: { TOLLWAY_SERVICE_PORT: "8787", TOLLWAY_SERVICE_API_KEYS: KEYS },
    });
    expect(config).toEqual({
      port: 8787,
      host: "127.0.0.1",
      apiKeys: [{ name: "ops", sha256: HASH, scopes: ["read"] }],
      readinessTimeoutMs: 2000,
      maxBodyBytes: 1_048_576,
    });
  });

  it("reads a config file and lets an environment variable override a field", () => {
    const config = parseServiceConfig({
      env: { TOLLWAY_SERVICE_PORT: "9000" },
      file: {
        port: 8080,
        host: "0.0.0.0",
        apiKeys: [{ name: "ops", sha256: HASH, scopes: ["ingest", "admin"] }],
      },
    });
    expect(config.port).toBe(9000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.apiKeys[0]?.scopes).toEqual(["ingest", "admin"]);
  });

  it("names each required field that is missing", () => {
    expect(issues(() => parseServiceConfig({ env: {} }))).toEqual([
      { field: 'TOLLWAY_SERVICE_PORT (or "port" in the config file)', message: "is required" },
      {
        field: 'TOLLWAY_SERVICE_API_KEYS (or "apiKeys" in the config file)',
        message: "is required",
      },
    ]);
  });

  it.each([
    [
      "a port that is not a number",
      { TOLLWAY_SERVICE_PORT: "eighty", TOLLWAY_SERVICE_API_KEYS: KEYS },
      "TOLLWAY_SERVICE_PORT",
    ],
    [
      "a port out of range",
      { TOLLWAY_SERVICE_PORT: "70000", TOLLWAY_SERVICE_API_KEYS: KEYS },
      "TOLLWAY_SERVICE_PORT",
    ],
    [
      "API keys that are not JSON",
      { TOLLWAY_SERVICE_PORT: "8787", TOLLWAY_SERVICE_API_KEYS: "[{name:" },
      "TOLLWAY_SERVICE_API_KEYS",
    ],
    [
      "an empty key list",
      { TOLLWAY_SERVICE_PORT: "8787", TOLLWAY_SERVICE_API_KEYS: "[]" },
      "TOLLWAY_SERVICE_API_KEYS",
    ],
    [
      "a plaintext key instead of a hash",
      {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
          { name: "ops", sha256: "my-secret-key", scopes: ["read"] },
        ]),
      },
      "TOLLWAY_SERVICE_API_KEYS [0].sha256",
    ],
    [
      "an unknown scope",
      {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
          { name: "ops", sha256: HASH, scopes: ["write"] },
        ]),
      },
      "TOLLWAY_SERVICE_API_KEYS [0].scopes[0]",
    ],
    [
      "a key with no scope",
      {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify([{ name: "ops", sha256: HASH, scopes: [] }]),
      },
      "TOLLWAY_SERVICE_API_KEYS [0].scopes",
    ],
    [
      "two keys with one name",
      {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
          { name: "ops", sha256: HASH, scopes: ["read"] },
          { name: "ops", sha256: "b".repeat(64), scopes: ["read"] },
        ]),
      },
      "TOLLWAY_SERVICE_API_KEYS [1].name",
    ],
    [
      "a readiness timeout of zero",
      {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: KEYS,
        TOLLWAY_SERVICE_READINESS_TIMEOUT_MS: "0",
      },
      "TOLLWAY_SERVICE_READINESS_TIMEOUT_MS",
    ],
  ])("refuses %s, naming the variable", (_name, env, field) => {
    expect(issues(() => parseServiceConfig({ env })).map((issue) => issue.field)).toEqual([field]);
  });

  it("never echoes the contents of a malformed key list", () => {
    const secretish = "[{secret-material";
    const found = issues(() =>
      parseServiceConfig({
        env: { TOLLWAY_SERVICE_PORT: "8787", TOLLWAY_SERVICE_API_KEYS: secretish },
      }),
    );
    expect(JSON.stringify(found)).not.toContain("secret-material");
  });

  it("refuses an unknown field in the config file", () => {
    expect(
      issues(() =>
        parseServiceConfig({
          env: {},
          file: { port: 8787, apiKeys: JSON.parse(KEYS), prot: 1 },
        }),
      ),
    ).toEqual([{ field: "config file prot", message: "unknown field" }]);
  });

  it("names the config file field when the file holds a bad value", () => {
    expect(
      issues(() =>
        parseServiceConfig({ env: {}, file: { port: "8787", apiKeys: JSON.parse(KEYS) } }),
      ),
    ).toEqual([{ field: "config file port", message: expect.any(String) }]);
  });
});

describe("loadServiceConfig", () => {
  it("reads the file named by TOLLWAY_SERVICE_CONFIG_FILE", () => {
    const config = loadServiceConfig(
      { TOLLWAY_SERVICE_CONFIG_FILE: "/etc/tollway/service.json" },
      (path) => {
        expect(path).toBe("/etc/tollway/service.json");
        return JSON.stringify({ port: 8787, apiKeys: JSON.parse(KEYS) });
      },
    );
    expect(config.port).toBe(8787);
  });

  it("names the variable when the file cannot be read or is not JSON", () => {
    const unreadable = issues(() =>
      loadServiceConfig({ TOLLWAY_SERVICE_CONFIG_FILE: "/missing.json" }, () => {
        throw new Error("ENOENT: no such file");
      }),
    );
    expect(unreadable).toEqual([
      { field: "TOLLWAY_SERVICE_CONFIG_FILE", message: expect.stringContaining("ENOENT") },
    ]);

    const notJson = issues(() =>
      loadServiceConfig({ TOLLWAY_SERVICE_CONFIG_FILE: "/bad.json" }, () => "port = 8787"),
    );
    expect(notJson).toEqual([
      { field: "TOLLWAY_SERVICE_CONFIG_FILE", message: expect.stringContaining("not valid JSON") },
    ]);
  });

  it("uses the environment alone when no file is named", () => {
    const config = loadServiceConfig(
      { TOLLWAY_SERVICE_PORT: "8787", TOLLWAY_SERVICE_API_KEYS: KEYS },
      () => {
        throw new Error("no file should be read");
      },
    );
    expect(config.port).toBe(8787);
  });
});
