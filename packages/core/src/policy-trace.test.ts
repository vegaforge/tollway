import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import { createPolicyEngine, type PaymentIntent, type Policy, type PolicyInput } from "./policy.js";
import { PolicyValidationError } from "./policy-schema.js";
import {
  comparePolicyTraces,
  decisionFromTrace,
  type PolicyRuleId,
  type PolicyTrace,
  type PolicyTraceEntry,
  policyRuleIds,
  policyTraceSchema,
} from "./policy-trace.js";
import { settlementModels } from "./types.js";

const NOW = new Date("2026-11-19T12:00:00Z").getTime();

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    payee: "GSERVICE",
    resource: "/api/quotes",
    amount: "100",
    asset: "USDC:GA5Z",
    model: "x402",
    ...overrides,
  };
}

function entry(trace: PolicyTrace, id: PolicyRuleId): PolicyTraceEntry {
  const found = trace.entries.find((e) => e.id === id);
  if (found === undefined) throw new Error(`trace has no ${id} entry`);
  return found;
}

function engine(policy: PolicyInput) {
  return createPolicyEngine(policy, { clock: () => NOW });
}

describe("evaluate trace shape", () => {
  it("lists every rule once, in the documented evaluation order", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(trace.entries.map((e) => e.id)).toEqual([...policyRuleIds]);
  });

  it("is versioned, parses with the published schema, and survives JSON", async () => {
    const trace = await engine({
      budgets: { daily: "1000", total: "5000" },
      perService: { GSERVICE: { cap: "500" } },
      perModel: { x402: { enabled: true } },
      rateLimit: { requestsPerMinute: 10 },
      anomaly: { maxSpendPerMinute: "2000" },
    }).evaluate(intent());
    expect(trace.version).toBe(1);
    expect(trace.evaluatedAt).toBe("2026-11-19T12:00:00.000Z");
    const roundTripped: unknown = JSON.parse(JSON.stringify(trace));
    expect(policyTraceSchema.parse(roundTripped)).toEqual(trace);
  });

  it("keeps the same key order in every entry, so stored traces diff cleanly", async () => {
    const trace = await engine({ budgets: { daily: "1" } }).evaluate(intent());
    for (const e of trace.entries) {
      expect(Object.keys(e)).toEqual([
        "id",
        "rule",
        "configured",
        "outcome",
        "limit",
        "current",
        "projected",
        "window",
        "detail",
      ]);
    }
  });

  it("carries the intent fields and nothing else about the request", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(trace.intent).toEqual(intent());
  });

  it("marks every rule not configured and not-applicable for an empty policy", async () => {
    const trace = await engine({}).evaluate(intent());
    for (const e of trace.entries) {
      expect(e).toMatchObject({
        configured: false,
        outcome: "not-applicable",
        limit: null,
        current: null,
        projected: null,
        window: null,
      });
    }
    expect(trace).toMatchObject({ allowed: true, wouldBlock: false, blockedBy: null });
  });

  it("rejects a stored trace whose summary contradicts its entries", async () => {
    const trace = await engine({ budgets: { daily: "50" } }).evaluate(intent());
    const tampered = { ...trace, allowed: true, wouldBlock: false, blockedBy: null };
    expect(policyTraceSchema.safeParse(tampered).success).toBe(false);
  });
});

describe("per-model-disabled trace", () => {
  it("passes an enabled model", async () => {
    const trace = await engine({ perModel: { x402: { enabled: true } } }).evaluate(intent());
    expect(entry(trace, "per-model-disabled")).toMatchObject({
      configured: true,
      outcome: "pass",
    });
  });

  it("fails a disabled model", async () => {
    const trace = await engine({ perModel: { x402: { enabled: false } } }).evaluate(intent());
    expect(entry(trace, "per-model-disabled")).toMatchObject({
      configured: true,
      outcome: "fail",
      rule: "per-model-disabled",
      detail: "settlement model x402 is disabled by policy",
    });
  });

  it("is configured but not applicable when another model is disabled", async () => {
    const trace = await engine({ perModel: { "mpp-channel": { enabled: false } } }).evaluate(
      intent(),
    );
    expect(entry(trace, "per-model-disabled")).toMatchObject({
      configured: true,
      outcome: "not-applicable",
    });
  });

  it("is not configured when no model is switched on or off", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(entry(trace, "per-model-disabled")).toMatchObject({
      configured: false,
      outcome: "not-applicable",
    });
  });
});

describe("min-channel-deposit trace", () => {
  const policy: Policy = {
    policyVersion: 1,
    perModel: { "mpp-channel": { minChannelDeposit: "200" } },
  };

  // #181: a payment is never compared with the minimum deposit. A channel open is.
  it("is not applicable to a channel payment, even one below the minimum", async () => {
    const trace = await engine(policy).evaluate(intent({ model: "mpp-channel", amount: "100" }));
    expect(entry(trace, "min-channel-deposit")).toMatchObject({
      configured: true,
      outcome: "not-applicable",
      limit: null,
      projected: null,
      window: null,
    });
  });

  it("does not apply to a model without a deposit", async () => {
    const trace = await engine(policy).evaluate(intent({ model: "x402", amount: "1" }));
    expect(entry(trace, "min-channel-deposit")).toMatchObject({
      configured: true,
      outcome: "not-applicable",
      limit: null,
    });
  });

  it("is not configured without a minimum", async () => {
    const trace = await engine({}).evaluate(intent({ model: "mpp-channel" }));
    expect(entry(trace, "min-channel-deposit")).toMatchObject({
      configured: false,
      outcome: "not-applicable",
    });
  });
});

describe("budget-daily trace", () => {
  it("passes within the budget, showing current and projected spend for the UTC day", async () => {
    const e = engine({ budgets: { daily: "250" } });
    await e.record(intent({ amount: "100" }));
    const trace = await e.evaluate(intent({ amount: "100" }));
    expect(entry(trace, "budget-daily")).toEqual({
      id: "budget-daily",
      rule: "budget",
      configured: true,
      outcome: "pass",
      limit: "250",
      current: "100",
      projected: "200",
      window: { kind: "utc-day", day: "2026-11-19" },
      detail: "daily budget for USDC:GA5Z: 200 <= 250",
    });
  });

  it("fails over the budget", async () => {
    const e = engine({ budgets: { daily: "150" } });
    await e.record(intent({ amount: "100" }));
    const trace = await e.evaluate(intent({ amount: "100" }));
    expect(entry(trace, "budget-daily")).toMatchObject({
      outcome: "fail",
      current: "100",
      projected: "200",
      detail: "daily budget exceeded for USDC:GA5Z: 200 > 150",
    });
  });

  it("is not configured without a daily budget", async () => {
    const trace = await engine({ budgets: { total: "1" } }).evaluate(intent());
    expect(entry(trace, "budget-daily")).toMatchObject({
      configured: false,
      outcome: "not-applicable",
    });
  });
});

describe("budget-total trace", () => {
  it("passes within the lifetime budget", async () => {
    const trace = await engine({ budgets: { total: "500" } }).evaluate(intent());
    expect(entry(trace, "budget-total")).toMatchObject({
      outcome: "pass",
      limit: "500",
      current: "0",
      projected: "100",
      window: { kind: "lifetime" },
      rule: "budget",
    });
  });

  it("fails over the lifetime budget", async () => {
    const e = engine({ budgets: { total: "150" } });
    await e.record(intent({ amount: "100" }));
    const trace = await e.evaluate(intent());
    expect(entry(trace, "budget-total")).toMatchObject({ outcome: "fail", projected: "200" });
  });

  it("is not configured without a total budget", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(entry(trace, "budget-total")).toMatchObject({ configured: false });
  });
});

describe("per-service trace", () => {
  it("passes within the cap", async () => {
    const trace = await engine({ perService: { GSERVICE: { cap: "200" } } }).evaluate(intent());
    expect(entry(trace, "per-service")).toMatchObject({
      outcome: "pass",
      limit: "200",
      current: "0",
      projected: "100",
      window: { kind: "lifetime" },
    });
  });

  it("fails over the cap", async () => {
    const e = engine({ perService: { GSERVICE: { cap: "150" } } });
    await e.record(intent());
    const trace = await e.evaluate(intent());
    expect(entry(trace, "per-service")).toMatchObject({ outcome: "fail", projected: "200" });
  });

  it("is configured but not applicable for a payee without a cap", async () => {
    const trace = await engine({ perService: { GOTHER: { cap: "1" } } }).evaluate(intent());
    expect(entry(trace, "per-service")).toMatchObject({
      configured: true,
      outcome: "not-applicable",
    });
  });

  it("is not configured without caps", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(entry(trace, "per-service")).toMatchObject({ configured: false });
  });
});

describe("rate-limit trace", () => {
  it("passes under the limit, counting this request in the projection", async () => {
    const e = engine({ rateLimit: { requestsPerMinute: 3 } });
    await e.record(intent());
    const trace = await e.evaluate(intent());
    expect(entry(trace, "rate-limit")).toMatchObject({
      outcome: "pass",
      limit: "3",
      current: "1",
      projected: "2",
      window: { kind: "sliding", seconds: 60 },
    });
  });

  it("fails at the limit", async () => {
    const e = engine({ rateLimit: { requestsPerMinute: 1 } });
    await e.record(intent());
    const trace = await e.evaluate(intent());
    expect(entry(trace, "rate-limit")).toMatchObject({
      outcome: "fail",
      detail: "global rate limit exceeded: 1 settled payments in the last 60 seconds, limit 1",
    });
  });

  it("is not configured without a limit", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(entry(trace, "rate-limit")).toMatchObject({ configured: false });
  });

  it("refuses a fractional limit at construction instead of rounding it", () => {
    expect(() => engine({ rateLimit: { requestsPerMinute: 2.5 } })).toThrow(PolicyValidationError);
  });
});

describe("anomaly trace", () => {
  it("passes under the per-minute ceiling", async () => {
    const trace = await engine({ anomaly: { maxSpendPerMinute: "500" } }).evaluate(intent());
    expect(entry(trace, "anomaly")).toMatchObject({
      outcome: "pass",
      limit: "500",
      current: "0",
      projected: "100",
      window: { kind: "sliding", seconds: 60 },
    });
  });

  it("fails over the per-minute ceiling", async () => {
    const e = engine({ anomaly: { maxSpendPerMinute: "150" } });
    await e.record(intent());
    const trace = await e.evaluate(intent());
    expect(entry(trace, "anomaly")).toMatchObject({ outcome: "fail", current: "100" });
  });

  it("is not configured without a ceiling", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(entry(trace, "anomaly")).toMatchObject({ configured: false });
  });
});

describe("evaluation after an earlier failure", () => {
  it("keeps evaluating every later rule and reports the first failure", async () => {
    const e = engine({
      perModel: { x402: { enabled: false } },
      budgets: { daily: "50", total: "1000" },
      perService: { GSERVICE: { cap: "50" } },
      rateLimit: { requestsPerMinute: 10 },
      anomaly: { maxSpendPerMinute: "1000" },
    });
    const trace = await e.evaluate(intent());
    expect(trace.entries.map((x) => [x.id, x.outcome])).toEqual([
      ["per-model-disabled", "fail"],
      ["min-channel-deposit", "not-applicable"],
      ["budget-daily", "fail"],
      ["budget-total", "pass"],
      ["per-service", "fail"],
      ["per-service-daily", "not-applicable"],
      ["per-service-window", "not-applicable"],
      ["per-resource", "not-applicable"],
      ["per-resource-daily", "not-applicable"],
      ["per-resource-window", "not-applicable"],
      ["rate-limit", "pass"],
      ["anomaly", "pass"],
      ["anomaly-adaptive", "not-applicable"],
    ]);
    expect(trace).toMatchObject({
      allowed: false,
      wouldBlock: true,
      blockedBy: "per-model-disabled",
    });
    expect(await e.check(intent())).toEqual({
      allowed: false,
      rule: "per-model-disabled",
      detail: "settlement model x402 is disabled by policy",
    });
  });

  it("does not record spend while evaluating", async () => {
    const e = engine({ budgets: { daily: "150" } });
    await e.evaluate(intent());
    await e.evaluate(intent());
    expect(entry(await e.evaluate(intent()), "budget-daily").current).toBe("0");
  });
});

describe("dry-run mode", () => {
  it("allows a payment that would be blocked, and marks the would-be block", async () => {
    const e = engine({ mode: "dry-run", budgets: { daily: "50" } });
    const trace = await e.evaluate(intent());
    expect(trace).toMatchObject({
      mode: "dry-run",
      allowed: true,
      wouldBlock: true,
      blockedBy: "budget-daily",
    });
    expect(entry(trace, "budget-daily").outcome).toBe("fail");
    expect(await e.check(intent())).toEqual({ allowed: true });
  });

  it("still records spend so the numbers stay real", async () => {
    const e = engine({ mode: "dry-run", budgets: { daily: "1000" } });
    await e.record(intent({ amount: "300" }));
    await e.record(intent({ amount: "300" }));
    expect(entry(await e.evaluate(intent()), "budget-daily")).toMatchObject({
      current: "600",
      projected: "700",
    });
  });

  it("is never the default", () => {
    expect(engine({}).mode).toBe("enforce");
  });

  it("refuses an unknown mode from untyped input instead of guessing", () => {
    const fromJson: Policy = JSON.parse('{"policyVersion":1,"mode":"dryrun"}');
    expect(() => engine(fromJson)).toThrow(TollwayError);
    expect(() => engine(fromJson)).toThrow(PolicyValidationError);
    try {
      engine(fromJson);
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as PolicyValidationError).issues).toEqual([
        { path: ["mode"], message: expect.any(String) },
      ]);
    }
  });
});

describe("decisionFromTrace", () => {
  it("refuses a blocking trace that names no failing rule", async () => {
    const trace = await engine({}).evaluate(intent());
    expect(() => decisionFromTrace({ ...trace, allowed: false })).toThrow(TollwayError);
  });
});

describe("comparePolicyTraces", () => {
  it("lists the rules whose outcome differs and whether the decision changes", async () => {
    const active = await engine({ budgets: { daily: "1000" } }).evaluate(intent());
    const candidate = await engine({
      budgets: { daily: "50" },
      anomaly: { maxSpendPerMinute: "1000" },
    }).evaluate(intent());
    expect(comparePolicyTraces(active, candidate)).toEqual({
      sameDecision: false,
      activeWouldBlock: false,
      candidateWouldBlock: true,
      differences: [
        { id: "budget-daily", active: "pass", candidate: "fail" },
        { id: "anomaly", active: "not-applicable", candidate: "pass" },
      ],
    });
  });

  it("compares would-block, ignoring the mode of either side", async () => {
    const active = await engine({ mode: "dry-run", budgets: { daily: "50" } }).evaluate(intent());
    const candidate = await engine({ budgets: { daily: "50" } }).evaluate(intent());
    expect(comparePolicyTraces(active, candidate)).toMatchObject({
      sameDecision: true,
      differences: [],
    });
  });
});

/**
 * A small seeded generator (mulberry32) so the property test is random in
 * coverage but identical on every run. A failure prints the seed and case
 * index, which is enough to replay it.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("check agrees with the trace (property)", () => {
  const SEED = 200;
  const CASES = 500;
  const random = seeded(SEED);
  const int = (max: number) => Math.floor(random() * (max + 1));
  const maybe = <T>(value: () => T): T | undefined => (random() < 0.5 ? value() : undefined);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const amount = () => String(int(400));
  const payees = ["GA", "GB"] as const;
  const assets = ["USDC", "EURC"] as const;

  function randomPolicy(): Policy {
    return {
      policyVersion: 1,
      budgets: { daily: maybe(amount), total: maybe(amount) },
      perService: { [pick(payees)]: { cap: maybe(amount) } },
      perModel: {
        [pick(settlementModels)]: {
          enabled: maybe(() => random() < 0.5),
          minChannelDeposit: maybe(amount),
        },
      },
      rateLimit: { requestsPerMinute: maybe(() => int(4)) },
      anomaly: { maxSpendPerMinute: maybe(amount) },
    };
  }

  function randomIntent(): PaymentIntent {
    return intent({
      payee: pick(payees),
      asset: pick(assets),
      amount: String(int(150)),
      model: pick(settlementModels),
    });
  }

  it(`holds for ${CASES} random policies and spend histories (seed ${SEED})`, async () => {
    for (let i = 0; i < CASES; i++) {
      let now = NOW;
      const e = createPolicyEngine(randomPolicy(), { clock: () => now });
      for (let r = int(4); r > 0; r--) {
        await e.record(randomIntent());
        now += int(40_000);
      }
      const probe = randomIntent();
      const trace = await e.evaluate(probe);
      const decision = await e.check(probe);
      const noFailingEntry = trace.entries.every((x) => x.outcome !== "fail");
      expect(decision.allowed, `case ${i}`).toBe(noFailingEntry);
      expect(trace.allowed, `case ${i}`).toBe(noFailingEntry);
      if (!decision.allowed) {
        const first = trace.entries.find((x) => x.outcome === "fail");
        expect(decision, `case ${i}`).toEqual({
          allowed: false,
          rule: first?.rule,
          detail: first?.detail,
        });
      }
      expect(policyTraceSchema.safeParse(trace).success, `case ${i}`).toBe(true);
    }
  });

  it("dry-run allows every case while flagging the same would-be blocks", async () => {
    for (let i = 0; i < 100; i++) {
      const policy = randomPolicy();
      const probe = randomIntent();
      const enforced = await engine(policy).evaluate(probe);
      const dry = engine({ ...policy, mode: "dry-run" });
      const dryTrace = await dry.evaluate(probe);
      expect(await dry.check(probe), `case ${i}`).toEqual({ allowed: true });
      expect(dryTrace.entries, `case ${i}`).toEqual(enforced.entries);
      expect(dryTrace.wouldBlock, `case ${i}`).toBe(enforced.wouldBlock);
    }
  });
});
