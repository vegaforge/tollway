import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { hashApiKey } from "./auth.js";
import { defineRoute } from "./routes.js";
import { bearer, KEYS, testService } from "./test-support.js";

// A route that needs the admin scope, mounted the way #225 to #228 will mount theirs.
const adminModule: ServiceModule = () => [
  defineRoute({
    method: "post",
    path: "/v1/admin-only",
    summary: "Test route",
    scope: "admin",
    request: { body: z.object({ value: z.string() }) },
    responses: { 200: { description: "ok" } },
    handler: (c, { body }) => c.json({ echoed: body.value }),
  }),
];

async function call(headers: Record<string, string>) {
  const { app, logger } = await testService({ modules: [adminModule] });
  const response = await app.request("/v1/admin-only", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ value: "x" }),
  });
  const text = await response.text();
  return { response, text, logger };
}

function headerText(headers: Headers): string {
  let text = "";
  headers.forEach((value, name) => {
    text += `${name}: ${value}\n`;
  });
  return text;
}

describe("hashApiKey", () => {
  it("is the lowercase hex SHA-256 of the key", async () => {
    // SHA-256("abc"), from FIPS 180-2 appendix B.1.
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("API-key authentication on /v1/*", () => {
  it.each([
    ["no Authorization header", {}, "send the API key"],
    [
      "the wrong scheme",
      { Authorization: `Basic ${btoa(`user:${KEYS.admin}`)}` },
      "expected Authorization: Bearer",
    ],
    [
      "a malformed bearer value",
      { Authorization: "Bearer two words" },
      "expected Authorization: Bearer",
    ],
    ["an unknown key", bearer("not-a-configured-key"), "not recognised"],
    ["a revoked key", bearer(KEYS.revoked), "revoked"],
  ])("answers 401 with a JSON error for %s", async (_name, headers, message) => {
    const { response, text } = await call(headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="tollway-service"');
    const body = JSON.parse(text);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toContain(message);
  });

  it("answers 403 for a valid key without the route's scope", async () => {
    const { response, text } = await call(bearer(KEYS.reader));
    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: { code: "forbidden", message: "this API key does not have the admin scope" },
    });
  });

  it("lets a key with the scope through", async () => {
    const { response, text } = await call(bearer(KEYS.admin));
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ echoed: "x" });
  });

  it("requires a key on unknown /v1 paths too, so they reveal nothing", async () => {
    const { app } = await testService();
    expect((await app.request("/v1/no-such-route")).status).toBe(401);
    expect((await app.request("/v1/no-such-route", { headers: bearer(KEYS.reader) })).status).toBe(
      404,
    );
  });

  it("never puts the key or its hash in a response or a log line", async () => {
    const secrets = [
      ...Object.values(KEYS),
      ...(await Promise.all(Object.values(KEYS).map((key) => hashApiKey(key)))),
    ];
    for (const headers of [
      {},
      bearer("wrong"),
      bearer(KEYS.reader),
      bearer(KEYS.revoked),
      bearer(KEYS.admin),
    ]) {
      const { response, text, logger } = await call(headers);
      const exposed = [text, headerText(response.headers), JSON.stringify(logger.lines)];
      for (const secret of secrets) {
        for (const surface of exposed) expect(surface).not.toContain(secret);
      }
      expect(JSON.stringify(logger.lines)).not.toContain("Bearer");
    }
  });

  it("logs the key name, not the key", async () => {
    const { logger } = await call(bearer(KEYS.admin));
    expect(logger.lines).toContainEqual({
      level: "info",
      event: "request",
      fields: expect.objectContaining({ path: "/v1/admin-only", status: 200, key: "admin" }),
    });
  });

  it("reports the calling key through /v1/whoami", async () => {
    const { app } = await testService();
    const response = await app.request("/v1/whoami", { headers: bearer(KEYS.admin) });
    expect(await response.json()).toEqual({ name: "admin", scopes: ["read", "admin"] });
  });
});
