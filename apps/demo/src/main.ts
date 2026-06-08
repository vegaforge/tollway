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

  if (!result.receiptValid) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});
