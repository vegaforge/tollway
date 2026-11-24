/**
 * all-models scenario: runs every scenario available today in sequence, so CI
 * exercises each settlement model end to end on every commit (docs/design.md,
 * "Testing"). MPP channel joins once the gate accepts vouchers (#173).
 */

import { runMppChargeScenario } from "./mpp-charge.js";
import type { ScenarioResult } from "./types.js";
import { runX402Scenario } from "./x402.js";

export type AllModelsResult = {
  results: ScenarioResult[];
  /** True only when every scenario's receipt verified. */
  allPassed: boolean;
};

/** One runner per scenario, in the order the summary table lists them. */
export type ScenarioRunner = () => Promise<ScenarioResult>;

const MOCK_RUNNERS: readonly ScenarioRunner[] = [
  () => runX402Scenario({ env: { MOCK_MODE: "true" } }),
  () => runMppChargeScenario(),
];

/**
 * Runs each scenario in mock mode and reports whether every receipt verified.
 * A scenario that throws fails the whole run; the error propagates.
 */
export async function runAllModels(
  runners: readonly ScenarioRunner[] = MOCK_RUNNERS,
): Promise<AllModelsResult> {
  const results: ScenarioResult[] = [];
  for (const run of runners) {
    results.push(await run());
  }
  return { results, allPassed: results.every((result) => result.receiptValid) };
}
