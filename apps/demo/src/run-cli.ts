/**
 * The demo command line. `main.ts` calls `runCli` with the process arguments;
 * it selects a scenario by its first argument:
 *
 *   pnpm --filter @vegaforge/tollway-demo start               # x402 (default)
 *   pnpm --filter @vegaforge/tollway-demo start -- x402
 *   pnpm --filter @vegaforge/tollway-demo start -- mpp-charge   # mock mode only
 *   pnpm --filter @vegaforge/tollway-demo start -- all-models   # mock mode only
 *
 * Set MOCK_MODE=true to run entirely offline. The MPP channel scenarios join
 * once the gate accepts channel vouchers (#173).
 */

import { FacilitatorCheckError } from "@vegaforge/tollway-server";
import { DemoConfigError } from "./config.js";
import { runDemo } from "./demo.js";
import type { runAllModels } from "./scenarios/all-models.js";
import { runMppChargeScenario } from "./scenarios/mpp-charge.js";
import type { ScenarioResult } from "./scenarios/types.js";

const SCENARIOS = ["x402", "mpp-charge", "all-models"] as const;

/** Where the CLI writes, so tests can capture output. */
export type CliOutput = { log: (line: string) => void; error: (line: string) => void };

/** What the CLI runs, so tests can substitute a failing scenario. */
export type CliDeps = {
  env: Readonly<Record<string, string | undefined>>;
  output: CliOutput;
  runAllModels: typeof runAllModels;
};

/**
 * pnpm passes arguments after `--` through, so `start -- all-models` arrives
 * as ["--", "all-models"]. Both that and `start all-models` select the same
 * scenario; no argument keeps the original x402 run.
 */
export function scenarioFromArgs(args: readonly string[]): string {
  const [first, second] = args;
  return (first === "--" ? second : first) ?? "x402";
}

function summaryRow(result: ScenarioResult): string {
  const status = result.receiptValid ? "ok  " : "FAIL";
  return `  ${status} ${result.scenario.padEnd(11)} ${result.resource.padEnd(40)} ${result.amount.padStart(8)} ${result.settlement ?? "-"}`;
}

async function runX402(deps: CliDeps): Promise<number> {
  const { output } = deps;
  const result = await runDemo({ env: deps.env });
  output.log(`Tollway x402 demo (${result.mock ? "MOCK_MODE" : "live facilitator"})`);
  output.log("");
  if (result.facilitatorCheck?.status === "ok") {
    output.log("0. Facilitator supports the paywall (checked against /supported)");
    output.log("   /supported does not list assets; the asset is confirmed at /verify");
  }
  output.log(`1. Agent requests ${result.challenge.resource}`);
  output.log(`   Service answers 402, asking ${result.challenge.amount} ${result.challenge.asset}`);
  output.log("2. Agent pays and retries");
  output.log("3. Service settles and returns the resource with a signed receipt");
  output.log("");
  output.log("Receipt:");
  output.log(JSON.stringify(result.receipt, null, 2));
  output.log("");
  output.log(`Receipt signature valid: ${result.receiptValid}`);
  const { settlement } = result.receipt.receipt;
  if (!result.mock && settlement.kind === "transaction") {
    output.log(`Settlement transaction: ${settlement.txHash}`);
  }
  return result.receiptValid ? 0 : 1;
}

/** Runs one scenario and returns the process exit code. */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const { output, env } = deps;
  const scenario = scenarioFromArgs(args);
  const mock = env.MOCK_MODE === "true";

  switch (scenario) {
    case "x402":
      return runX402(deps);
    case "mpp-charge": {
      if (!mock) {
        output.error("The mpp-charge scenario runs in mock mode only. Set MOCK_MODE=true.");
        return 1;
      }
      const result = await runMppChargeScenario();
      output.log(summaryRow(result));
      output.log(`Receipt signature valid: ${result.receiptValid}`);
      return result.receiptValid ? 0 : 1;
    }
    case "all-models": {
      if (!mock) {
        output.error("The all-models scenario runs in mock mode only. Set MOCK_MODE=true.");
        return 1;
      }
      const { results, allPassed } = await deps.runAllModels();
      output.log(
        `  ${"ok".padEnd(4)} ${"model".padEnd(11)} ${"resource".padEnd(40)} ${"amount".padStart(8)} settlement`,
      );
      for (const result of results) output.log(summaryRow(result));
      output.log("");
      output.log(`All receipts valid: ${allPassed}`);
      return allPassed ? 0 : 1;
    }
    default:
      output.error(`Unknown scenario "${scenario}". Valid scenarios: ${SCENARIOS.join(", ")}.`);
      return 1;
  }
}

/** Prints a failure the user can act on without a stack trace where possible. */
export function reportFailure(error: unknown, output: CliOutput): void {
  // A configuration problem is the user's to fix, so print the list without
  // a stack trace. Anything else is a bug or an upstream failure: keep the stack.
  if (error instanceof DemoConfigError) {
    output.error("Live mode is not configured. Set MOCK_MODE=true to run offline, or fix:");
    for (const problem of error.problems) {
      output.error(`  - ${problem}`);
    }
  } else if (error instanceof FacilitatorCheckError) {
    // The facilitator cannot settle this paywall as configured: name each
    // mismatch instead of printing a stack trace.
    output.error(`The facilitator check failed before serving: ${error.message}`);
  } else {
    output.error(
      `Demo failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}
