/**
 * CLI entry for the budget-capped scenario:
 *
 *   MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start:budget-capped
 *
 * The scenario always runs offline; MOCK_MODE is part of the command so it
 * matches the rest of the demo. It prints the narrative and exits non-zero if
 * the run does not reach the stops and drift it is meant to show, because
 * every one of those is an invariant of the demo.
 */

import { runBudgetCappedScenario } from "./budget-capped.js";

async function main(): Promise<void> {
  const result = await runBudgetCappedScenario({ print: (line) => console.log(line) });

  const ok =
    result.budget.blocked.rule === "budget" &&
    result.anomaly.blocked.rule === "anomaly" &&
    result.drift.underSettled.kind === "under-settled" &&
    result.drift.sequenceGap.kind === "sequence-gap" &&
    result.drift.anomalyEvents === 2;

  if (!ok) {
    console.error("The scenario did not produce the stops and drift it is meant to demonstrate.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("Budget-capped demo failed:", error);
  process.exitCode = 1;
});
