/**
 * all-models scenario: runs x402, mpp-charge, and mpp-channel in sequence and
 * prints one summary table. Exits non-zero if any receipt fails verifyReceipt
 * or any reconciliation is not ok.
 *
 * See docs/design.md, "Testing": "The end-to-end demo exercising all three
 * models runs in CI on every commit."
 */

import { runMppChannelScenario } from "./mpp-channel.js";
import { runMppChargeScenario } from "./mpp-charge.js";
import type { ScenarioOptions, ScenarioResult } from "./types.js";
import { runX402Scenario } from "./x402.js";

export type AllModelsResult = {
  results: ScenarioResult[];
  allPassed: boolean;
};

/**
 * Runs all three payment model scenarios in sequence, prints a summary table,
 * and returns whether every receipt is valid and every reconciliation is ok.
 */
export async function runAllModels(options: ScenarioOptions): Promise<AllModelsResult> {
  const results: ScenarioResult[] = [];

  results.push(await runX402Scenario(options));
  results.push(await runMppChargeScenario(options));
  results.push(await runMppChannelScenario(options));

  const allPassed = results.every((r) => {
    if (r.scenario === "x402" || r.scenario === "mpp-charge") {
      return r.receiptValid;
    }
    if (r.scenario === "mpp-channel") {
      return r.commitments.every((c) => c.receiptValid) && r.reconciliationOk;
    }
    if (r.scenario === "high-frequency") {
      return r.reconciliationOk;
    }
    return false;
  });

  return { results, allPassed };
}
