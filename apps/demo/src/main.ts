import { DemoConfigError } from "./config.js";
import { runDemo } from "./demo.js";

async function main(): Promise<void> {
  const result = await runDemo();

  console.log(`Tollway x402 demo (${result.mock ? "MOCK_MODE" : "live facilitator"})`);
  console.log("");
  console.log(`1. Agent requests ${result.challenge.resource}`);
  console.log(
    `   Service answers 402, asking ${result.challenge.amount} ${result.challenge.asset}`,
  );
  console.log("2. Agent pays and retries");
  console.log("3. Service settles and returns the resource with a signed receipt");
  console.log("");
  console.log("Receipt:");
  console.log(JSON.stringify(result.receipt, null, 2));
  console.log("");
  console.log(`Receipt signature valid: ${result.receiptValid}`);

  const { settlement } = result.receipt.receipt;
  if (!result.mock && settlement.kind === "transaction") {
    console.log(`Settlement transaction: ${settlement.txHash}`);
  }

  if (!result.receiptValid) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // A configuration problem is the user's to fix, so print the list without
  // a stack trace. Anything else is a bug or an upstream failure: keep the stack.
  if (error instanceof DemoConfigError) {
    console.error("Live mode is not configured. Set MOCK_MODE=true to run offline, or fix:");
    for (const problem of error.problems) {
      console.error(`  - ${problem}`);
    }
  } else {
    console.error("Demo failed:", error);
  }
  process.exitCode = 1;
});
