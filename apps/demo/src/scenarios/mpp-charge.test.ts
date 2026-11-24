import { describe, expect, it } from "vitest";
import { runMppChargeScenario } from "./mpp-charge.js";

describe("runMppChargeScenario", () => {
  it("pays the same route with only the model switched, and verifies the receipt", async () => {
    const result = await runMppChargeScenario();

    expect(result.scenario).toBe("mpp-charge");
    expect(result.mock).toBe(true);
    expect(result.resource).toMatch(/\/quotes\/latest$/);
    expect(result.amount).toBe("10000");
    expect(result.receipt.receipt.model).toBe("mpp-charge");
    expect(result.receipt.receipt.settlement.kind).toBe("transaction");
    expect(result.settlement).toBeDefined();
    expect(result.receiptValid).toBe(true);
  });
});
