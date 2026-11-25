import { describe, expect, it } from "vitest";
import { QUOTE_PRICE, runPaidToolDemo } from "./main.js";

describe("paid MCP tool example (mock mode)", () => {
  it("challenges, settles once after the tool runs, and replays the receipt", async () => {
    const run = await runPaidToolDemo();

    expect(run.unpaid.isError).toBe(true);
    expect(run.unpaid.accepts).toMatchObject([{ amount: QUOTE_PRICE, network: "stellar:testnet" }]);
    expect(run.paid.text).toBe("XLM/USD 0.1234");
    expect(run.paid.receiptValid).toBe(true);
    expect(run.paid.receipt.receipt.resource).toBe("mcp://tool/get-quote");
    expect(run.replay.sameReceipt).toBe(true);
    expect(run.settlements).toBe(1);
  });
});
