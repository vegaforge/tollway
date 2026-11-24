/**
 * x402 scenario: one per-request x402 payment producing a canonical receipt.
 * It is the original demo (`runDemo`), so live mode, the facilitator
 * capability check and the receipt verification all behave exactly as before.
 */

import { type DemoOptions, runDemo } from "../demo.js";
import type { ScenarioResult } from "./types.js";

export async function runX402Scenario(options: DemoOptions = {}): Promise<ScenarioResult> {
  const result = await runDemo(options);
  const { settlement } = result.receipt.receipt;
  return {
    scenario: "x402",
    mock: result.mock,
    resource: result.challenge.resource,
    amount: result.challenge.amount,
    asset: result.challenge.asset,
    settlement: settlement.kind === "transaction" ? settlement.txHash : undefined,
    receipt: result.receipt,
    receiptValid: result.receiptValid,
  };
}
