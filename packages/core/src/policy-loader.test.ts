import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicyFile, PolicyLoadError } from "./policy-loader.js";
import { POLICY_VERSION } from "./policy-schema.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tollway-policy-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(name: string, contents: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

describe("loadPolicyFile", () => {
  it("loads and validates a current policy file", async () => {
    const path = await write(
      "policy.json",
      JSON.stringify({ policyVersion: POLICY_VERSION, budgets: { daily: "100" } }),
    );
    await expect(loadPolicyFile(path)).resolves.toEqual({
      policyVersion: POLICY_VERSION,
      budgets: { daily: "100" },
    });
  });

  it("migrates a legacy policy file", async () => {
    const path = await write("legacy.json", JSON.stringify({ budgets: { total: "500" } }));
    await expect(loadPolicyFile(path)).resolves.toEqual({
      policyVersion: POLICY_VERSION,
      budgets: { total: "500" },
    });
  });

  it("reports invalid JSON as a typed json error", async () => {
    const path = await write("broken.json", "{ not json");
    await expect(loadPolicyFile(path)).rejects.toMatchObject({
      name: "PolicyLoadError",
      kind: "json",
      filePath: path,
    });
  });

  it("reports every validation issue with its path", async () => {
    const path = await write(
      "invalid.json",
      JSON.stringify({
        policyVersion: 1,
        budgets: { daily: "1.5" },
        rateLimit: { requestsPerMinute: -1 },
      }),
    );
    const error = await loadPolicyFile(path).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PolicyLoadError);
    const loadError = error as PolicyLoadError;
    expect(loadError.kind).toBe("validation");
    expect(loadError.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["budgets.daily", "rateLimit.requestsPerMinute"]),
    );
    expect(loadError.message).toContain("budgets.daily");
  });

  it("reports a missing file as a typed read error", async () => {
    const path = join(directory, "missing.json");
    await expect(loadPolicyFile(path)).rejects.toMatchObject({
      name: "PolicyLoadError",
      kind: "read",
      filePath: path,
    });
  });
});
