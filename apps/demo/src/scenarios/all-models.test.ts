import { describe, expect, it } from "vitest";
import { runAllModels } from "./all-models.js";
import { runMppChargeScenario } from "./mpp-charge.js";
import { runX402Scenario } from "./x402.js";

describe("runAllModels", () => {
  it("runs x402 then mpp-charge in mock mode, and every receipt verifies", async () => {
    const { results, allPassed } = await runAllModels();

    expect(results.map((result) => result.scenario)).toEqual(["x402", "mpp-charge"]);
    expect(results.map((result) => result.receipt.receipt.model)).toEqual(["x402", "mpp-charge"]);
    expect(results.every((result) => result.receiptValid)).toBe(true);
    expect(allPassed).toBe(true);
  });

  it("reports failure when any scenario's receipt does not verify", async () => {
    const { allPassed } = await runAllModels([
      () => runX402Scenario({ env: { MOCK_MODE: "true" } }),
      async () => ({ ...(await runMppChargeScenario()), receiptValid: false }),
    ]);

    expect(allPassed).toBe(false);
  });

  it("propagates a scenario that throws instead of reporting success", async () => {
    await expect(
      runAllModels([
        async () => {
          throw new Error("settlement failed");
        },
      ]),
    ).rejects.toThrow("settlement failed");
  });
});
