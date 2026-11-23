import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import {
  formatPolicyIssues,
  POLICY_SCHEMA_ID,
  POLICY_VERSION,
  PolicyValidationError,
  parsePolicy,
  policyJsonSchema,
  policySchema,
} from "./policy-schema.js";

const SCHEMA_PATH = fileURLToPath(new URL("../schema/policy.schema.json", import.meta.url));

function issuePaths(input: unknown): string[] {
  const result = parsePolicy(input);
  if (result.ok) throw new Error("expected the policy to be invalid");
  return result.issues.map((issue) => issue.path.join("."));
}

describe("policySchema", () => {
  it("accepts an empty current-version policy", () => {
    const result = parsePolicy({ policyVersion: POLICY_VERSION });
    expect(result).toEqual({ ok: true, policy: { policyVersion: POLICY_VERSION } });
  });

  it("accepts every documented rule", () => {
    const result = parsePolicy({
      policyVersion: POLICY_VERSION,
      mode: "dry-run",
      budgets: { daily: "1000", total: "5000" },
      perService: { GSERVICE: { cap: "500" } },
      perModel: { "mpp-channel": { enabled: true, minChannelDeposit: "200" } },
      rateLimit: { requestsPerMinute: 30 },
      anomaly: {
        maxSpendPerMinute: "2000",
        adaptive: {
          kind: "ewma",
          smoothing: { numerator: "1", denominator: "2" },
          sensitivity: { numerator: "3", denominator: "1" },
          warmupPeriods: 2,
          scope: "asset-payee",
          maxBaselineGrowthPerMinute: "10",
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(policySchema.parse(result.policy)).toEqual(result.policy);
  });

  it("accepts every issue #192 cap kind", () => {
    const result = parsePolicy({
      policyVersion: POLICY_VERSION,
      perService: {
        GSERVICE: { cap: "1000", dailyCap: "500", window: { windowSeconds: 3600, cap: "100" } },
      },
      perResource: {
        "/api/": {
          match: "prefix",
          cap: "900",
          dailyCap: "400",
          window: { windowSeconds: 60, cap: "50" },
        },
        "/api/quotes": { match: "exact", cap: "10" },
        "/health": { dailyCap: "1" },
      },
    });
    if (!result.ok) throw new Error(formatPolicyIssues(result.issues));
    expect(() => createPolicyEngine(result.policy)).not.toThrow();
  });

  it("accepts a $schema line so editors can find the JSON Schema", () => {
    const result = parsePolicy({ $schema: POLICY_SCHEMA_ID, policyVersion: POLICY_VERSION });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a decimal amount", { policyVersion: 1, budgets: { daily: "1.5" } }, ["budgets.daily"]],
    ["a negative amount", { policyVersion: 1, budgets: { total: "-1" } }, ["budgets.total"]],
    [
      "a negative rate",
      { policyVersion: 1, rateLimit: { requestsPerMinute: -1 } },
      ["rateLimit.requestsPerMinute"],
    ],
    [
      "a fractional rate",
      { policyVersion: 1, rateLimit: { requestsPerMinute: 2.5 } },
      ["rateLimit.requestsPerMinute"],
    ],
    [
      "a NaN rate",
      { policyVersion: 1, rateLimit: { requestsPerMinute: Number.NaN } },
      ["rateLimit.requestsPerMinute"],
    ],
    ["an unknown root key", { policyVersion: 1, budget: { daily: "1" } }, ["budget"]],
    [
      "an unknown nested key (a typo)",
      { policyVersion: 1, budgets: { dialy: "100" } },
      ["budgets.dialy"],
    ],
    [
      "an unknown per-model key",
      { policyVersion: 1, perModel: { y402: { enabled: true } } },
      ["perModel.y402"],
    ],
    [
      "an unknown per-service key",
      { policyVersion: 1, perService: { GSERVICE: { capp: "1" } } },
      ["perService.GSERVICE.capp"],
    ],
    ["an unknown mode", { policyVersion: 1, mode: "dryrun" }, ["mode"]],
    [
      "a warm-up of zero",
      {
        policyVersion: 1,
        anomaly: {
          adaptive: {
            kind: "ewma",
            smoothing: { numerator: "1", denominator: "2" },
            sensitivity: { numerator: "3", denominator: "1" },
            warmupPeriods: 0,
          },
        },
      },
      ["anomaly.adaptive.warmupPeriods"],
    ],
    [
      "smoothing above one",
      {
        policyVersion: 1,
        anomaly: {
          adaptive: {
            kind: "ewma",
            smoothing: { numerator: "3", denominator: "2" },
            sensitivity: { numerator: "3", denominator: "1" },
            warmupPeriods: 1,
          },
        },
      },
      ["anomaly.adaptive.smoothing"],
    ],
    [
      "a zero rational denominator",
      {
        policyVersion: 1,
        anomaly: {
          adaptive: {
            kind: "ewma",
            smoothing: { numerator: "1", denominator: "0" },
            sensitivity: { numerator: "3", denominator: "1" },
            warmupPeriods: 1,
          },
        },
      },
      ["anomaly.adaptive.smoothing.denominator"],
    ],
  ])("rejects %s with the field path", (_name, input, expectedPaths) => {
    expect(issuePaths(input)).toEqual(expect.arrayContaining(expectedPaths));
  });

  it("reports every issue, not just the first", () => {
    const paths = issuePaths({
      policyVersion: 1,
      budgets: { daily: "one" },
      rateLimit: { requestsPerMinute: -2 },
      perModel: { nope: {} },
    });
    expect(paths).toEqual(
      expect.arrayContaining(["budgets.daily", "rateLimit.requestsPerMinute", "perModel.nope"]),
    );
  });
});

describe("parsePolicy migration", () => {
  it("migrates the unversioned legacy shape to the current version", () => {
    const result = parsePolicy({ budgets: { daily: "100" }, mode: "enforce" });
    expect(result).toEqual({
      ok: true,
      migratedFrom: 0,
      policy: { policyVersion: POLICY_VERSION, budgets: { daily: "100" }, mode: "enforce" },
    });
  });

  it("migrates an explicit version 0 document", () => {
    const result = parsePolicy({ policyVersion: 0, budgets: { total: "5" } });
    expect(result).toMatchObject({
      ok: true,
      migratedFrom: 0,
      policy: { policyVersion: POLICY_VERSION, budgets: { total: "5" } },
    });
  });

  it("does not report a migration for a current document", () => {
    const result = parsePolicy({ policyVersion: POLICY_VERSION });
    expect(result).not.toHaveProperty("migratedFrom");
  });

  it("refuses a version it does not know, naming the supported versions", () => {
    const result = parsePolicy({ policyVersion: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: ["policyVersion"],
          message: expect.stringContaining("supported versions are 0"),
        },
      ]);
    }
  });

  it("rejects a non-object document at the root", () => {
    expect(issuePaths("not a policy")).toEqual([""]);
  });
});

describe("createPolicyEngine validation", () => {
  it("throws one typed error listing every issue at construction", () => {
    let thrown: unknown;
    try {
      createPolicyEngine({
        policyVersion: POLICY_VERSION,
        budgets: { daily: "1.5" },
        rateLimit: { requestsPerMinute: -1 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolicyValidationError);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as PolicyValidationError;
    expect(error.code).toBe("invalid-policy");
    expect(error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["budgets.daily", "rateLimit.requestsPerMinute"]),
    );
    expect(error.message).toContain("budgets.daily");
    expect(error.message).toContain("rateLimit.requestsPerMinute");
  });

  it("accepts and migrates the legacy shape", () => {
    const engine = createPolicyEngine({ budgets: { daily: "100" } });
    expect(engine.mode).toBe("enforce");
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(() => createPolicyEngine({ policyVersion: 1, mode: "dryrun" as never })).toThrow(
      PolicyValidationError,
    );
  });
});

describe("committed JSON Schema", () => {
  it("matches the schema generated from policySchema", async () => {
    const generated = policyJsonSchema();
    if (process.env.UPDATE_POLICY_SCHEMA === "1") {
      await mkdir(dirname(SCHEMA_PATH), { recursive: true });
      await writeFile(SCHEMA_PATH, `${JSON.stringify(generated, null, 2)}\n`);
    }
    // Compare documents, not bytes: Biome formats arrays inline, so a
    // regenerated file legitimately differs in whitespace from the generator.
    const committed: unknown = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
    expect(
      committed,
      "packages/core/schema/policy.schema.json is stale. Regenerate it with UPDATE_POLICY_SCHEMA=1 pnpm --filter @vegaforge/tollway-core test -- policy-schema, then run pnpm biome check --write packages/core/schema/policy.schema.json",
    ).toEqual(generated);
  });

  it("describes the version and keeps objects closed", () => {
    const schema = policyJsonSchema();
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain(`"policyVersion"`);
    expect(serialized).toContain(`"const":1`);
    expect(serialized).toContain(`"additionalProperties":false`);
  });
});
