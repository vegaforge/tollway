import { beforeAll, describe, expect, it } from "vitest";
import {
  ANOMALY_STOP_POLICY,
  BUDGET_STOP_POLICY,
  type BudgetCappedResult,
  PAYMENTS_IN_BUDGET,
  ROUTE_PRICE,
  runBudgetCappedScenario,
} from "./budget-capped.js";

/**
 * The scenario is deterministic (injected clock, sequential payments, mock
 * facilitator), so one run covers every assertion. Keeping it to one run also
 * keeps the suite fast: each run stands up a real HTTP server.
 */
describe("budget-capped scenario", () => {
  let result: BudgetCappedResult;

  beforeAll(async () => {
    result = await runBudgetCappedScenario();
  });

  it("runs offline in mock mode", () => {
    expect(result.mock).toBe(true);
  });

  it("sets the daily budget to exactly K times the route price", () => {
    expect(BUDGET_STOP_POLICY.budgets?.daily).toBe(
      (BigInt(PAYMENTS_IN_BUDGET) * BigInt(ROUTE_PRICE)).toString(),
    );
    expect(result.budget.dailyBudget).toBe(BUDGET_STOP_POLICY.budgets?.daily);
    expect(result.budget.price).toBe(ROUTE_PRICE);
  });

  it("lets exactly K payments succeed and refuses payment K+1 on the budget rule", () => {
    expect(result.budget.settled).toHaveLength(PAYMENTS_IN_BUDGET);
    expect(result.budget.blocked.index).toBe(PAYMENTS_IN_BUDGET + 1);
    expect(result.budget.blocked.rule).toBe("budget");
    expect(result.budget.blocked.detail).toContain("daily budget exceeded");
  });

  it("never sends request K+1 to the service", () => {
    expect(result.budget.facilitatorVerifyCalls).toBe(PAYMENTS_IN_BUDGET);
    expect(result.budget.facilitatorSettleCalls).toBe(PAYMENTS_IN_BUDGET);
  });

  it("surfaces the budget stop as a client skip event", () => {
    expect(result.budget.skips).toHaveLength(1);
    expect(result.budget.skips[0]).toMatch(/^budget: /);
  });

  it("leaves no partial state after the policy stop", () => {
    // The refused evaluation recorded nothing: spend is still K payments.
    expect(result.budget.spentAfterBlock).toBe(result.budget.dailyBudget);
    // The budget is fully spent, so the only amount that fits what is left is
    // zero. It is allowed, which would be false if the refusal had recorded
    // any of its own amount.
    expect(result.budget.probeAllowed).toBe(true);
  });

  it("trips the anomaly stop at the documented projected-minute point", () => {
    const max = ANOMALY_STOP_POLICY.anomaly?.maxSpendPerMinute;
    if (!max) throw new Error("the anomaly policy has no maxSpendPerMinute");
    const paymentsThatFit = BigInt(max) / BigInt(ROUTE_PRICE);

    expect(result.anomaly.maxSpendPerMinute).toBe(max);
    expect(result.anomaly.settled).toHaveLength(Number(paymentsThatFit));
    expect(result.anomaly.blocked.index).toBe(Number(paymentsThatFit) + 1);
    expect(result.anomaly.blocked.rule).toBe("anomaly");
    expect(result.anomaly.blocked.detail).toContain("anomaly stop");
  });

  it("does not reach the facilitator for the refused burst request", () => {
    expect(result.anomaly.facilitatorVerifyCalls).toBe(result.anomaly.settled.length);
    expect(result.anomaly.skips).toHaveLength(1);
    expect(result.anomaly.skips[0]).toMatch(/^anomaly: /);
  });

  it("shows the manager refusing a close that settled less than the commitment", () => {
    expect(result.drift.closeRefused).toEqual({
      expectedSettled: "30000",
      actualSettled: "25000",
    });
    // The manager parks the channel as settlement-mismatched: the close is on
    // chain, so it cannot reopen, and an operator has to look at it.
    expect(result.drift.channelStatusAfterRefusal).toBe("settlement-mismatched");
  });

  it("flags the under-settled drift with its shortfall", () => {
    expect(result.drift.underSettled.kind).toBe("under-settled");
    expect(result.drift.underSettled.shortfall).toBe("5000");
    expect(result.drift.underSettled.detail).toContain("shortfall: 5000");
  });

  it("flags a sequence gap when a commitment is missing from the stream", () => {
    expect(result.drift.sequenceGap.kind).toBe("sequence-gap");
    expect(result.drift.sequenceGap.detail).toContain("expected sequence 1, got 2");
    expect(result.drift.sequenceGap.shortfall).toBeNull();
  });

  it("emits one anomaly.detected per drift through the observability hub", () => {
    expect(result.drift.anomalyEvents).toBe(2);
  });

  it("returns a narrative an operator can follow", () => {
    const narrative = result.narrative.join("\n");
    expect(narrative).toContain("Phase 1: a daily budget of K times the route price");
    expect(narrative).toContain(
      "Phase 2: the operator raises the budget and caps spend per minute",
    );
    expect(narrative).toContain("Phase 3: channel drift");
    expect(narrative).toContain("refused before payment: budget");
    expect(narrative).toContain("refused before payment: anomaly");
    expect(narrative).toContain("hub handler received anomaly.detected");
    expect(narrative).toContain("manager refused the close");
  });
});
