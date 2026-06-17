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

    it("throws TollwayError when daily budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "150" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await expect(engine.check(intent({ amount: "100" }))).rejects.toThrow(TollwayError);
    });

    it("includes budget-exceeded code in the error", async () => {
      const engine = createPolicyEngine({ budgets: { daily: "150" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      try {
        await engine.check(intent({ amount: "100" }));
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TollwayError);
        expect((e as TollwayError).code).toBe("budget-exceeded");
      }
    });
  });

  describe("total budget", () => {
    it("allows payments within the total budget", async () => {
      const engine = createPolicyEngine({ budgets: { total: "500" } });
      const result = await engine.check(intent({ amount: "200" }));
      expect(result).toEqual({ allowed: true });
    });

    it("throws TollwayError when total budget is exceeded", async () => {
      const engine = createPolicyEngine({ budgets: { total: "250" } });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await expect(engine.check(intent({ amount: "100" }))).rejects.toThrow(TollwayError);
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
  });

  describe("combined policies", () => {
    it("checks rules in order: budget before per-service", async () => {
      const engine = createPolicyEngine({
        budgets: { daily: "150" },
        perService: { GSERVICE: { cap: "500" } },
      });
      await engine.check(intent({ amount: "100" }));
      await engine.record(intent({ amount: "100" }));
      await expect(engine.check(intent({ amount: "100" }))).rejects.toThrow(TollwayError);
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
