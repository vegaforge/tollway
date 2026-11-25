/**
 * An agent that pays for an MCP tool through the Tollway client (#207).
 *
 * The agent asks for three forecasts with a budget that covers two. The
 * first two calls are paid and their receipts verified and stored; the third
 * is refused by the policy before anything is signed. The script ends by
 * printing the spend summary from the receipt store.
 *
 * Mock mode: the tool is in process and nothing settles on chain. The agent
 * signs with `signPayment`, which stands in for a Stellar signer.
 */

import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryReceiptStore, PolicyBlockedError } from "@vegaforge/tollway-client";
import { createTollwayMcpClient } from "@vegaforge/tollway-client/mcp";
import { createPolicyEngine, Ed25519Signer, Ed25519Verifier } from "@vegaforge/tollway-core";
import { createPaidWeatherServer } from "./paid-weather-server.js";

const AGENT = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const SERVICE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

export type ForecastOutcome =
  | { city: string; status: "paid"; forecast: string; receiptId: string }
  | { city: string; status: "blocked"; rule: string };

export type McpAgentRun = {
  outcomes: ForecastOutcome[];
  spend: { payee: string; asset: string; amount: string; count: number }[];
};

export async function runMcpAgent(): Promise<McpAgentRun> {
  const serviceKey = await Ed25519Signer.generate("paid-weather");
  const server = createPaidWeatherServer({ signer: serviceKey, payTo: SERVICE, payer: AGENT });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "forecast-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  const receipts = createMemoryReceiptStore();
  const agent = createTollwayMcpClient({
    client: mcp,
    network: "testnet",
    payer: AGENT,
    // Mock signing. With a real key, pass `signer` from @x402/stellar instead.
    signPayment: async ({ paymentRequired, requirements }) => ({
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { transaction: "mock-signed-auth-entry" },
    }),
    // A daily budget of two forecasts.
    policy: createPolicyEngine({ budgets: { daily: "10000" } }),
    verifier: Ed25519Verifier.forSigner(serviceKey),
    receiptStore: receipts,
  });

  const outcomes: ForecastOutcome[] = [];
  try {
    for (const city of ["Lagos", "Accra", "Nairobi"]) {
      try {
        const call = await agent.callTool({ name: "forecast", arguments: { city } });
        const first = call.result.content[0];
        outcomes.push({
          city,
          status: "paid",
          forecast: typeof first?.text === "string" ? first.text : "",
          receiptId: call.receipt?.receipt.id ?? "",
        });
      } catch (error) {
        if (!(error instanceof PolicyBlockedError)) throw error;
        outcomes.push({ city, status: "blocked", rule: error.rule });
      }
    }
  } finally {
    await mcp.close();
  }

  const totals = await receipts.totals();
  return { outcomes, spend: totals.byPayeeAsset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runMcpAgent();
  for (const outcome of run.outcomes) {
    console.log(
      outcome.status === "paid"
        ? `${outcome.city}: ${outcome.forecast} (receipt ${outcome.receiptId})`
        : `${outcome.city}: blocked by policy rule "${outcome.rule}"`,
    );
  }
  console.log("\nSpend summary (base units):");
  for (const row of run.spend) {
    console.log(`  ${row.payee} ${row.asset}: ${row.amount} over ${row.count} payment(s)`);
  }
}
