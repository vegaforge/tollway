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
  createInMemorySettlementCache,
  createMockFacilitator,
  type FacilitatorClient,
  type SettlementCache,
} from "@vegaforge/tollway-server";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  MCP_TOLLWAY_RECEIPT_META_KEY,
  type McpToolExtra,
  type PaidToolConfig,
  type PaidToolDeps,
  paidTool,
} from "./index.js";

const config = {
  toolName: "get-quote",
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  description: "Latest market quote",
} satisfies PaidToolConfig;

function payment(
  transaction = "signed-soroban-tx-1",
  edit: Partial<PaymentPayload["accepted"]> = {},
): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "mcp://tool/get-quote" },
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
      ...edit,
    },
    payload: { transaction },
  };
}

/** The mock facilitator, recording the order of verify and settle calls. */
function recordingFacilitator(order: string[] = []): FacilitatorClient & {
  settle: ReturnType<typeof vi.fn>;
} {
  const base = createMockFacilitator();
  return {
    ...base,
    async verify(input) {
      order.push("verify");
      return base.verify(input);
    },
    settle: vi.fn(async (input: Parameters<FacilitatorClient["settle"]>[0]) => {
      order.push("settle");
      return base.settle(input);
    }),
  };
}

type ToolHandler = (args: { symbol: string }, extra: McpToolExtra) => Promise<ToolResult>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
const open: Client[] = [];

beforeAll(async () => {
  signer = await Ed25519Signer.generate("mcp-tool-key");
  verifier = await Ed25519Verifier.forSigner(signer);
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

/** A real MCP server with one paid tool, connected to a client in memory. */
async function connect(deps: PaidToolDeps, handler: ToolHandler, toolConfig = config) {
  const server = new McpServer({ name: "paid-tools", version: "1.0.0" });
  server.registerTool(
    toolConfig.toolName,
    { description: toolConfig.description, inputSchema: { symbol: z.string() } },
    paidTool(toolConfig, deps)(handler),
  );
  const client = new Client({ name: "agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client);
  return (pay?: unknown) =>
    client.callTool({
      name: toolConfig.toolName,
      arguments: { symbol: "XLM" },
      ...(pay === undefined ? {} : { _meta: { [MCP_PAYMENT_META_KEY]: pay } }),
    });
}

function quoteTool(order: string[] = []): ToolHandler & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ symbol }: { symbol: string }) => {
    order.push("execute");
    return { content: [{ type: "text" as const, text: `quote:${symbol}` }] };
  });
}

describe("paidTool over an MCP client and server (#206)", () => {
  it("answers an unpaid call with the x402 PaymentRequired result and does not run the tool", async () => {
    const tool = quoteTool();
    const call = await connect({ signer, facilitator: createMockFacilitator() }, tool);

    const result = await call();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      x402Version: 2,
      error: "Payment required to access this tool",
      resource: { url: "mcp://tool/get-quote", description: "Latest market quote" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: config.asset,
          amount: "10000",
          payTo: config.payTo,
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    });
    // The spec: content[0].text is JSON.stringify of the same object.
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
    expect(tool).not.toHaveBeenCalled();
  });

  it("verifies, runs the tool, then settles, and returns the settlement and a bound receipt", async () => {
    const order: string[] = [];
    const call = await connect(
      { signer, facilitator: recordingFacilitator(order), receiptVersion: 2 },
      quoteTool(order),
    );

    const result = await call(payment());

    expect(order).toEqual(["verify", "execute", "settle"]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "quote:XLM" }]);
    const signed = result._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY] as SignedReceipt;
    expect((await verifyReceipt(signed, verifier)).valid).toBe(true);
    expect(signed.receipt).toMatchObject({
      resource: "mcp://tool/get-quote",
      amount: config.amount,
      asset: config.asset,
      payee: config.payTo,
      network: "testnet",
      model: "x402",
      method: "tools/call",
    });
    expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual({
      success: true,
      transaction:
        signed.receipt.settlement.kind === "transaction" && signed.receipt.settlement.txHash,
      network: "stellar:testnet",
      payer: signed.receipt.payer,
    });
    // Neither the payment nor the receipt signer's key goes into text content.
    expect(JSON.stringify(result.content)).not.toContain("signed-soroban-tx-1");
  });

  it("replays a retried payment from the cache without settling it again", async () => {
    const facilitator = recordingFacilitator();
    const tool = quoteTool();
    const call = await connect(
      { signer, facilitator, cache: createInMemorySettlementCache() },
      tool,
    );

    const first = await call(payment("signed-soroban-tx-replay"));
    const retry = await call(payment("signed-soroban-tx-replay"));

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(retry._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toEqual(
      first._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY],
    );
    expect(retry._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(
      first._meta?.[MCP_PAYMENT_RESPONSE_META_KEY],
    );
    // A replay re-serves the call, as a replayed payment re-serves an HTTP route.
    expect(retry.content).toEqual([{ type: "text", text: "quote:XLM" }]);
    expect(tool).toHaveBeenCalledTimes(2);
  });

  it("settles two simultaneous calls with the same payment once", async () => {
    const facilitator = recordingFacilitator();
    const call = await connect(
      { signer, facilitator, cache: createInMemorySettlementCache() },
      quoteTool(),
    );

    const [a, b] = await Promise.all([
      call(payment("signed-soroban-tx-race")),
      call(payment("signed-soroban-tx-race")),
    ]);

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(a._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toEqual(
      b._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY],
    );
  });

  it("does not settle when the tool throws, and the same payment still works afterwards", async () => {
    const facilitator = recordingFacilitator();
    let fail = true;
    const call = await connect({ signer, facilitator }, async ({ symbol }) => {
      if (fail) throw new Error("upstream down");
      return { content: [{ type: "text", text: `quote:${symbol}` }] };
    });

    const failed = await call(payment("signed-soroban-tx-throw"));
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("upstream down");
    expect(failed._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();

    fail = false;
    const retried = await call(payment("signed-soroban-tx-throw"));
    expect(retried.isError).toBeFalsy();
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("returns a tool's isError result without settling", async () => {
    const facilitator = recordingFacilitator();
    const call = await connect({ signer, facilitator }, async () => ({
      isError: true,
      content: [{ type: "text", text: "unknown symbol" }],
    }));

    const result = await call(payment());

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "unknown symbol" }],
    });
    expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("returns only the payment error when settlement fails after the tool ran", async () => {
    const base = createMockFacilitator();
    const facilitator: FacilitatorClient = {
      ...base,
      settle: async () => ({ settled: false, reason: "insufficient balance" }),
    };
    const tool = quoteTool();
    const call = await connect({ signer, facilitator }, tool);

    const result = await call(payment());

    expect(tool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      x402Version: 2,
      error: "Payment settlement failed: insufficient balance",
    });
    expect(JSON.stringify(result.content)).not.toContain("quote:XLM");
  });

  it("rejects malformed, mismatched and unverifiable payments before the tool runs", async () => {
    const tool = quoteTool();
    const call = await connect({ signer, facilitator: createMockFacilitator() }, tool);

    const malformed = await call({ bad: true });
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent).toMatchObject({
      error: "x402/payment is not an x402 V2 PaymentPayload",
    });

    const cheaper = await call(payment("signed-soroban-tx-2", { amount: "1" }));
    expect(cheaper.structuredContent).toMatchObject({
      error: "payment amount does not match this tool: expected 10000, got 1",
    });

    const otherPayee = await call(payment("signed-soroban-tx-3", { payTo: "GOTHER" }));
    expect(otherPayee.isError).toBe(true);

    // The mock facilitator refuses a payload with no transaction.
    const unverified = await call(payment(""));
    expect(unverified.structuredContent).toMatchObject({
      error: "payment payload carries no transaction",
    });

    expect(tool).not.toHaveBeenCalled();
  });

  it("reports a cache write failure without losing the settled receipt", async () => {
    const onCacheError = vi.fn();
    const failingCache: SettlementCache = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error("redis down");
      },
    };
    const call = await connect(
      { signer, facilitator: createMockFacilitator(), cache: failingCache, onCacheError },
      quoteTool(),
    );

    const result = await call(payment());

    expect(result.isError).toBeFalsy();
    expect(result._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toBeDefined();
    expect(onCacheError).toHaveBeenCalledTimes(1);
    expect(onCacheError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("refuses a receipt cached for another tool that shares the settlement cache", async () => {
    const cache = createInMemorySettlementCache();
    const facilitator = createMockFacilitator();
    const quote = await connect({ signer, facilitator, cache }, quoteTool());
    const other = await connect({ signer, facilitator, cache }, quoteTool(), {
      ...config,
      toolName: "get-news",
    });

    await quote(payment("signed-soroban-tx-shared"));
    // The payment names get-quote's terms, which get-news shares, so only the
    // cached receipt's binding to get-quote's resource stops the replay.
    const result = await other(payment("signed-soroban-tx-shared"));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "payment already settled for a different offer",
    });
  });
});

describe("paidTool configuration", () => {
  it("refuses a tool it cannot charge for", () => {
    const deps = { signer, facilitator: createMockFacilitator() };
    expect(() => paidTool({ ...config, toolName: "" }, deps)).toThrow(/toolName/);
    expect(() => paidTool({ ...config, amount: "0.01" }, deps)).toThrow(/amount/);
    expect(() => paidTool({ ...config, models: ["mpp-charge"] }, deps)).toThrow(/x402/);
  });
});
