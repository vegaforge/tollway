import { describe, expect, it } from "vitest";
import { runPaymentOptionsScenario } from "./payment-options.js";

describe("payment-options scenario (#158)", () => {
  it("offers two options in one 402 and settles the one the agent chose", async () => {
    const result = await runPaymentOptionsScenario();
    expect(result.offered).toEqual(["stellar:pubnet 10000", "stellar:testnet 20000"]);
    expect(result.receipt.receipt).toMatchObject({ network: "testnet", amount: "20000" });
    expect(result.receiptValid).toBe(true);
  });
});
