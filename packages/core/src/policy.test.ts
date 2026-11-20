import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import type { PaymentIntent } from "./policy.js";
import { createPolicyEngine } from "./policy.js";

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

describe("createPolicyEngine", () => {
  describe("daily budget", () => {
    it("allows payments within the daily budget", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "200" } });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when daily budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "150" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "budget",
        detail: expect.stringContaining("daily budget exceeded"),
      });
    });

    it("resets daily spend on a new UTC day", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine({ budgets: { daily: "150" } }, { clock: () => now });
      await engine.record(intent({ amount: "100" }));
      const before = await engine.check(intent({ amount: "100" }));
      expect(before).toEqual({ allowed: false, rule: "budget", detail: expect.any(String) });

      now = new Date("2026-06-11T00:01:00Z").getTime();
      const after = await engine.check(intent({ amount: "100" }));
      expect(after).toEqual({ allowed: true });
    });
  });

  describe("total budget", () => {
    it("allows payments within the total budget", async () => {
      const engine = createPolicyEngine({ budgets: { total: "500" } });
      const result = await engine.check(intent({ amount: "200" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when total budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { total: "250" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "budget",
        detail: expect.stringContaining("total budget exceeded"),
      });
    });
  });

  describe("per-service cap", () => {
    it("allows payments within the service cap", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "200" } },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when per-service cap is exceeded", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "150" } },
      });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-service",
        detail: expect.stringContaining("per-service cap exceeded"),
      });
    });

    it("tracks per-service spend per asset", async () => {
      const engine = createPolicyEngine({
        perService: { GSERVICE: { cap: "150" } },
      });
      await engine.record(intent({ amount: "100", asset: "USDC:GA5Z" }));
      const result = await engine.check(intent({ amount: "100", asset: "EURC:GBBB" }));
      expect(result).toEqual({ allowed: true });
    });
  });

  describe("per-model constraints", () => {
    it("blocks a disabled settlement model", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.stringContaining("disabled by policy"),
      });
    });

    it("allows an enabled settlement model", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { enabled: true } },
      });
      const result = await engine.check(intent({ model: "mpp-channel" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when amount is below min channel deposit", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { minChannelDeposit: "200" } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "min-channel-deposit",
        detail: expect.stringContaining("below minimum channel deposit"),
      });
    });

    it("allows when amount meets min channel deposit", async () => {
      const engine = createPolicyEngine({
        perModel: { "mpp-channel": { minChannelDeposit: "100" } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("reports a disabled model before budget", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "50" },
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.any(String),
      });
    });
  });

  describe("rate limit", () => {
    it("allows requests within the rate limit", async () => {
      const engine = createPolicyEngine({
        rateLimit: { requestsPerMinute: 3 },
      });
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const result = await engine.check(intent({ amount: "10" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when rate limit is exceeded", async () => {
      const engine = createPolicyEngine({
        rateLimit: { requestsPerMinute: 2 },
      });
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const result = await engine.check(intent({ amount: "10" }));
      expect(result).toEqual({
        allowed: false,
        rule: "rate-limit",
        detail: expect.stringContaining("rate limit exceeded"),
      });
    });

    it("allows requests after the window rolls", async () => {
      let now = new Date("2026-06-10T12:00:00Z").getTime();
      const engine = createPolicyEngine(
        { rateLimit: { requestsPerMinute: 2 } },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "10" }));
      await engine.record(intent({ amount: "10" }));
      const blocked = await engine.check(intent({ amount: "10" }));
      expect(blocked).toEqual({ allowed: false, rule: "rate-limit", detail: expect.any(String) });

      now = new Date("2026-06-10T12:01:05Z").getTime();
      const allowed = await engine.check(intent({ amount: "10" }));
      expect(allowed).toEqual({ allowed: true });
    });
  });

  describe("anomaly stop", () => {
    it("allows spending within the anomaly threshold", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "500" },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });

    it("blocks when projected spend exceeds anomaly threshold", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "150" },
      });
      await engine.record(intent({ amount: "100" }));
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "anomaly",
        detail: expect.stringContaining("anomaly stop"),
      });
    });

    it("tracks anomaly spend per asset", async () => {
      const engine = createPolicyEngine({
        anomaly: { maxSpendPerMinute: "150" },
      });
      await engine.record(intent({ amount: "100", asset: "USDC:GA5Z" }));
      const result = await engine.check(intent({ amount: "100", asset: "EURC:GBBB" }));
      expect(result).toEqual({ allowed: true });
    });

    it("does not block during adaptive warm-up, then blocks a spike", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "2" },
              sensitivity: { numerator: "3", denominator: "1" },
              warmupPeriods: 2,
              scope: "asset",
            },
          },
        },
        { clock: () => now },
      );

      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      expect(await engine.check(intent({ amount: "1000" }))).toEqual({
        allowed: false,
        rule: "anomaly-adaptive",
        detail: expect.stringContaining("baseline 100"),
      });
    });

    it("caps baseline growth per completed minute", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "3", denominator: "1" },
              warmupPeriods: 1,
              maxBaselineGrowthPerMinute: "10",
            },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "1000" }));
      now += 60_000;
      await engine.record(intent({ amount: "0" }));
      const trace = await engine.evaluate(intent({ amount: "1000" }));
      expect(trace.entries.find((entry) => entry.id === "anomaly-adaptive")?.detail).toContain(
        "baseline 110",
      );
    });

    it("isolates adaptive baselines by payee when configured", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "1", denominator: "1" },
              warmupPeriods: 1,
              scope: "asset-payee",
            },
          },
        },
        { clock: () => now },
      );
      await engine.record(intent({ amount: "100", payee: "A" }));
      now += 60_000;
      await engine.record(intent({ amount: "100", payee: "A" }));
      expect(await engine.check(intent({ amount: "1000", payee: "B" }))).toEqual({ allowed: true });
    });

    it("reports an adaptive block through the anomaly callback", async () => {
      let now = Date.parse("2026-06-10T12:00:00Z");
      const events: string[] = [];
      const engine = createPolicyEngine(
        {
          anomaly: {
            adaptive: {
              kind: "ewma",
              smoothing: { numerator: "1", denominator: "1" },
              sensitivity: { numerator: "1", denominator: "1" },
              warmupPeriods: 1,
            },
          },
        },
        {
          clock: () => now,
          onAnomalyDetected: (event) => {
            events.push(event.detail);
          },
        },
      );
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await engine.record(intent({ amount: "100" }));
      now += 60_000;
      await expect(engine.check(intent({ amount: "1000" }))).resolves.toMatchObject({
        allowed: false,
        rule: "anomaly-adaptive",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toContain("adaptive anomaly stop");
    });

    it("keeps a stationary stream below a generous sensitivity across seeds", async () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        let now = Date.parse("2026-06-10T12:00:00Z");
        const engine = createPolicyEngine(
          {
            anomaly: {
              adaptive: {
                kind: "ewma",
                smoothing: { numerator: "1", denominator: "2" },
                sensitivity: { numerator: "10", denominator: "1" },
                warmupPeriods: 2,
              },
            },
          },
          { clock: () => now },
        );
        const amount = 100 + (seed % 3);
        await engine.record(intent({ amount: String(amount) }));
        for (let minute = 1; minute < 8; minute += 1) {
          now += 60_000;
          expect((await engine.check(intent({ amount: String(amount) }))).allowed).toBe(true);
          await engine.record(intent({ amount: String(amount) }));
        }
      }
    });

    it("is monotone for larger spikes from the same learned state", async () => {
      const makeEngine = () => {
        let now = Date.parse("2026-06-10T12:00:00Z");
        const engine = createPolicyEngine(
          {
            anomaly: {
              adaptive: {
                kind: "ewma",
                smoothing: { numerator: "1", denominator: "2" },
                sensitivity: { numerator: "3", denominator: "1" },
                warmupPeriods: 2,
              },
            },
          },
          { clock: () => now },
        );
        return { engine, advance: () => (now += 60_000) };
      };
      const small = makeEngine();
      const large = makeEngine();
      for (const pair of [small, large]) {
        await pair.engine.record(intent({ amount: "100" }));
        pair.advance();
        await pair.engine.record(intent({ amount: "100" }));
        pair.advance();
        await pair.engine.record(intent({ amount: "100" }));
      }
      const smallDecision = await small.engine.check(intent({ amount: "150" }));
      const largeDecision = await large.engine.check(intent({ amount: "1000" }));
      expect(largeDecision.allowed).toBe(false);
      expect(smallDecision.allowed || !largeDecision.allowed).toBe(true);
    });
  });

  describe("invalid amount", () => {
    it("rejects a non-numeric amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "abc" }))).rejects.toThrow(TollwayError);
    });

    it("rejects a decimal amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "1.5" }))).rejects.toThrow(TollwayError);
    });

    it("rejects a negative amount", async () => {
      const engine = createPolicyEngine({});
      await expect(engine.check(intent({ amount: "-10" }))).rejects.toThrow(TollwayError);
    });

    it("uses the invalid-amount error code", async () => {
      const engine = createPolicyEngine({});
      try {
        await engine.check(intent({ amount: "abc" }));
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TollwayError);
        expect((e as TollwayError).code).toBe("invalid-amount");
      }
    });
  });

  describe("combined policies", () => {
    it("checks per-model before budget", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "50" },
        perModel: { "mpp-channel": { enabled: false } },
      });
      const result = await engine.check(intent({ model: "mpp-channel", amount: "100" }));
      expect(result).toEqual({
        allowed: false,
        rule: "per-model-disabled",
        detail: expect.any(String),
      });
    });

    it("passes all rules when within all limits", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "1000", total: "5000" },
        perService: { GSERVICE: { cap: "500" } },
        perModel: { x402: { enabled: true } },
        rateLimit: { requestsPerMinute: 10 },
        anomaly: { maxSpendPerMinute: "2000" },
      });
      const result = await engine.check(intent({ amount: "100" }));
      expect(result).toEqual({ allowed: true });
    });
  });
});
