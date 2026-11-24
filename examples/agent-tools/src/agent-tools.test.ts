import { describe, expect, it } from "vitest";
import { runAiAgent } from "./ai-agent.js";
import { runMcpAgent } from "./mcp-agent.js";
import { FORECAST_PRICE, USDC } from "./paid-weather-server.js";

describe("MCP agent example", () => {
  it("pays for two forecasts, is blocked on the third, and sums the spend", async () => {
    const run = await runMcpAgent();

    expect(run.outcomes.map((outcome) => outcome.status)).toEqual(["paid", "paid", "blocked"]);
    expect(run.outcomes[0]).toMatchObject({
      city: "Lagos",
      forecast: expect.stringContaining("Lagos"),
    });
    expect(run.outcomes[2]).toMatchObject({ status: "blocked", rule: "budget" });
    expect(run.spend).toEqual([
      expect.objectContaining({
        asset: USDC,
        amount: String(2n * BigInt(FORECAST_PRICE)),
        count: 2,
      }),
    ]);
  });
});

describe("AI SDK agent example", () => {
  it("pays for the allowed URL and refuses the other origin before any request", async () => {
    const run = await runAiAgent();

    expect(run.toolResults).toEqual([
      expect.objectContaining({
        status: "ok",
        paid: true,
        receipt: expect.objectContaining({ amount: "10000" }),
      }),
      expect.objectContaining({ status: "blocked", rule: "origin-not-allowed" }),
    ]);
    expect(run.text).toBe("XLM/USD is 0.4123.");
  });
});
