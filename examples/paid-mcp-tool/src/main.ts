import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  MCP_TOLLWAY_RECEIPT_META_KEY,
  paidTool,
} from "@vegaforge/tollway-mcp";
import { createInMemorySettlementCache, createMockFacilitator } from "@vegaforge/tollway-server";
import { z } from "zod";

/**
 * A paid MCP tool, end to end, in mock mode. The server registers one tool,
 * `get-quote`, behind `paidTool(...)`. An agent in the same process calls it
 * three times over an in-memory MCP transport: without a payment (it gets
 * the x402 PaymentRequired result), with a payment (the tool runs, then the
 * payment settles), and with the same payment again (the receipt is
 * replayed and nothing settles twice). No network and no secrets.
 */

/** 0.001 USDC in 7-decimal base units: the price of one call. */
export const QUOTE_PRICE = "10000";

/** Testnet USDC's Soroban contract address. */
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** A testnet account generated for the examples; its secret was discarded. */
const PAY_TO = "GBR4MM3F4WLDE7VETP5FL4TQDTYIRR7A6QI3JPDCM4BSOHMRIABLSU4K";

/** What the demo saw, step by step, so the test can check it. */
export type PaidToolRun = {
  unpaid: { isError: boolean; accepts: unknown };
  paid: { text: string; receipt: SignedReceipt; receiptValid: boolean; transaction: string };
  replay: { sameReceipt: boolean };
  settlements: number;
};

/** Starts the server and the agent, makes the three calls, and closes both. */
export async function runPaidToolDemo(): Promise<PaidToolRun> {
  // A key per process keeps the example short. A real service loads a stable
  // key so receipts verify after a restart: see examples/next-paid-api.
  const signer = await Ed25519Signer.generate("tollway-example-paid-mcp-tool");
  const mock = createMockFacilitator();
  let settlements = 0;
  const facilitator = {
    ...mock,
    settle: async (input: Parameters<typeof mock.settle>[0]) => {
      settlements += 1;
      return mock.settle(input);
    },
  };

  const server = new McpServer({ name: "tollway-paid-tools", version: "1.0.0" });
  server.registerTool(
    "get-quote",
    { description: "Latest XLM/USD quote", inputSchema: { symbol: z.string() } },
    paidTool(
      {
        toolName: "get-quote",
        amount: QUOTE_PRICE,
        asset: USDC_TESTNET,
        payTo: PAY_TO,
        network: "testnet",
        description: "Latest XLM/USD quote",
      },
      { signer, facilitator, cache: createInMemorySettlementCache() },
    )(async ({ symbol }: { symbol: string }) => ({
      content: [{ type: "text" as const, text: `${symbol}/USD 0.1234` }],
    })),
  );

  const agent = new Client({ name: "example-agent", version: "1.0.0" });
  const [agentTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await agent.connect(agentTransport);

  try {
    const unpaid = await agent.callTool({ name: "get-quote", arguments: { symbol: "XLM" } });
    const challenge = z
      .object({ accepts: z.array(z.record(z.string(), z.unknown())).min(1) })
      .parse(unpaid.structuredContent);

    // A real agent signs a Soroban authorization entry here with
    // @x402/stellar. The mock facilitator accepts any transaction string.
    const payment = {
      x402Version: 2,
      resource: { url: "mcp://tool/get-quote" },
      accepted: challenge.accepts[0],
      payload: { transaction: "mock-signed-auth-entry" },
    };
    const paidCall = () =>
      agent.callTool({
        name: "get-quote",
        arguments: { symbol: "XLM" },
        _meta: { [MCP_PAYMENT_META_KEY]: payment },
      });

    const paid = await paidCall();
    const receipt = paid._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY] as SignedReceipt;
    const settleResponse = z
      .object({ success: z.literal(true), transaction: z.string() })
      .parse(paid._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]);
    const verification = await verifyReceipt(receipt, await Ed25519Verifier.forSigner(signer));
    const text = z.array(z.object({ text: z.string() })).parse(paid.content)[0]?.text ?? "";

    const replay = await paidCall();

    return {
      unpaid: { isError: unpaid.isError === true, accepts: challenge.accepts },
      paid: {
        text,
        receipt,
        receiptValid: verification.valid,
        transaction: settleResponse.transaction,
      },
      replay: {
        sameReceipt:
          JSON.stringify(replay._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]) === JSON.stringify(receipt),
      },
      settlements,
    };
  } finally {
    await agent.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const run = await runPaidToolDemo();
  console.log(`1. unpaid call: isError=${run.unpaid.isError}, PaymentRequired.accepts:`);
  console.log(JSON.stringify(run.unpaid.accepts, null, 2));
  console.log(`2. paid call: "${run.paid.text}", settled in ${run.paid.transaction}`);
  console.log(
    `   receipt ${run.paid.receipt.receipt.id} for ${run.paid.receipt.receipt.resource}, signature valid=${run.paid.receiptValid}`,
  );
  console.log(`3. same payment again: same receipt=${run.replay.sameReceipt}`);
  console.log(`settlements: ${run.settlements}`);
}

// Start only when this file is the entry point, so the test can import it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("paid-mcp-tool example failed:", error);
    process.exitCode = 1;
  });
}
