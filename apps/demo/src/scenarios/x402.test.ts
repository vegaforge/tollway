import { describe, expect, it } from "vitest";
import { runX402Scenario } from "./x402.js";

describe("runX402Scenario", () => {
  it("is the original demo run, reported in the scenario shape", async () => {
    const result = await runX402Scenario({ env: { MOCK_MODE: "true" } });

    expect(result.scenario).toBe("x402");
    expect(result.mock).toBe(true);
    expect(result.amount).toBe("10000");
    expect(result.receipt.receipt.model).toBe("x402");
    expect(result.receiptValid).toBe(true);
  });
});
