import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDemo } from "./demo.js";

describe("runDemo", () => {
  beforeEach(() => {
    process.env.MOCK_MODE = "true";
  });
  afterEach(() => {
    process.env.MOCK_MODE = undefined;
  });

  it("runs the x402 happy path end to end and verifies the receipt", async () => {
    const result = await runDemo();

    expect(result.mock).toBe(true);
    expect(result.challenge.amount).toBe("10000");
    expect(result.receipt.receipt.model).toBe("x402");
    expect(result.receipt.receipt.settlement.kind).toBe("transaction");
    expect(result.receiptValid).toBe(true);
  });
});
