import { describe, expect, it } from "vitest";
import { checkSmartAccountPolicy, planSmartAccountPolicy } from "./smart-account-policy.js";

describe("smart-account policy mapping", () => {
  it("plans token-scoped daily limits and reports residual rules", () => {
    const plan = planSmartAccountPolicy(
      {
        policyVersion: 1,
        budgets: { daily: "1000", total: "5000" },
        perService: { SERVICE: { cap: "100" } },
        anomaly: { maxSpendPerMinute: "500" },
      },
      { tokenContracts: { USDC: "CUSDC" }, dailyPeriodLedgers: 17_280 },
    );
    expect(plan.constraints).toEqual([
      {
        asset: "USDC",
        tokenContract: "CUSDC",
        limit: "1000",
        periodLedgers: 17_280,
        sourceRule: "budget-daily",
      },
    ]);
    expect(plan.invocations[0]?.unsigned).toBe(true);
    expect(plan.residual.map((entry) => entry.rule)).toEqual([
      "budget-total",
      "per-service",
      "anomaly",
      "budget-daily",
    ]);
  });

  it("reports the issue #192 caps as residual", () => {
    // A per-service daily or window cap, or any perResource cap, cannot be
    // expressed as an account spending limit, so the plan must say so
    // rather than imply the account enforces it.
    const plan = planSmartAccountPolicy(
      {
        perService: { SERVICE: { dailyCap: "100", window: { windowSeconds: 3600, cap: "50" } } },
        perResource: { "/api/": { match: "prefix", cap: "100" } },
      },
      { tokenContracts: { USDC: "CUSDC" }, dailyPeriodLedgers: 17_280 },
    );
    expect(plan.residual.map((entry) => entry.rule)).toEqual(["per-service", "per-resource"]);
  });

  it("checks weaker, equal, stronger, and missing limits", async () => {
    const plan = planSmartAccountPolicy(
      { policyVersion: 1, budgets: { daily: "100" } },
      { tokenContracts: { A: "CA", B: "CB", C: "CC", D: "CD" }, dailyPeriodLedgers: 10 },
    );
    const result = await checkSmartAccountPolicy(plan, {
      readSpendingLimits: async () => [
        { asset: "A", tokenContract: "CA", limit: "101", periodLedgers: 10 },
        { asset: "B", tokenContract: "CB", limit: "100", periodLedgers: 10 },
        { asset: "C", tokenContract: "CC", limit: "99", periodLedgers: 10 },
      ],
    });
    expect(result.map((entry) => entry.status)).toEqual(["weaker", "equal", "stronger", "missing"]);
  });
});
