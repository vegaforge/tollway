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
} from "@vegaforge/tollway-server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPaidMcpTool,
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  MCP_TOLLWAY_RECEIPT_META_KEY,
  type McpToolConfig,
} from "./index.js";

const PAYEE = "GB3JDWCQ2R7I4E2T2R7X7N5C2P6Q2M4Z7K4L2V5Y2B7G3F2K3J4H5M6N";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const config: McpToolConfig = {
  toolName: "get-quote",
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  network: "testnet",
  description: "Fetch latest market quote",
};

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("mcp-tool-key");
  verifier = new Ed25519Verifier(await signer.publicJwk());
});

function makePayment(txSuffix = "tx-1", overrides?: Partial<{ amount: string; payTo: string }>) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC,
      amount: overrides?.amount ?? config.amount,
      payTo: overrides?.payTo ?? PAYEE,
      maxTimeoutSeconds: 60,
    },
    payload: {
      transaction: `signed-soroban-tx-${txSuffix}`,
    },
  };
}

describe("@vegaforge/tollway-mcp (#206)", () => {
  it("returns PaymentRequired when _meta['x402/payment'] is absent", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = createPaidMcpTool(
      config,
      { signer, facilitator: createMockFacilitator() },
      handler,
    );

    const res = await tool({ symbol: "XLM" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      x402Version: 2,
      resource: { url: "mcp://tool/get-quote", description: "Fetch latest market quote" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: USDC,
          amount: "10000",
          payTo: PAYEE,
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("verifies, executes, settles, and attaches SettleResponse and signed Tollway receipt", async () => {
    const order: string[] = [];
    const base = createMockFacilitator();
    const facilitator: FacilitatorClient = {
      ...base,
      async verify(input) {
        order.push("verify");
        return base.verify(input);
      },
      async settle(input) {
        order.push("settle");
        return base.settle(input);
      },
    };
    const handler = vi.fn(async (args: { symbol: string }) => {
      order.push("execute");
      return { content: [{ type: "text", text: `quote:${args.symbol}` }] };
    });

    const tool = createPaidMcpTool(config, { signer, facilitator }, handler);
    const res = await tool(
      { symbol: "XLM" },
      { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("1") } },
    );

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: "quote:XLM" }]);
    expect(order).toEqual(["verify", "execute", "settle"]);

    const settleResponse = res._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as {
      success: boolean;
      transaction: string;
      network: string;
    };
    expect(settleResponse.success).toBe(true);
    expect(settleResponse.network).toBe("stellar:testnet");

    const receipt = res._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY] as SignedReceipt;
    const verification = await verifyReceipt(receipt, verifier);
    expect(verification.valid).toBe(true);
    expect(receipt.resource).toBe("mcp://tool/get-quote");
    expect(receipt.amount).toBe("10000");
    expect(receipt.model).toBe("x402");
  });

  it("does not settle when the tool throws or returns isError: true", async () => {
    const base = createMockFacilitator();
    const settleSpy = vi.fn(base.settle);
    const facilitator: FacilitatorClient = { ...base, settle: settleSpy };

    const throwingTool = createPaidMcpTool(config, { signer, facilitator }, async () => {
      throw new Error("upstream down");
    });
    const threwRes = await throwingTool({}, { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("2") } });
    expect(threwRes.isError).toBe(true);
    expect(settleSpy).not.toHaveBeenCalled();

    const errorResultTool = createPaidMcpTool(config, { signer, facilitator }, async () => ({
      isError: true,
      content: [{ type: "text", text: "bad args" }],
    }));
    const errRes = await errorResultTool(
      {},
      { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("3") } },
    );
    expect(errRes.isError).toBe(true);
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it("replays cached settlement without settling twice and deduplicates concurrent calls", async () => {
    const base = createMockFacilitator();
    const settleSpy = vi.fn(base.settle);
    const facilitator: FacilitatorClient = { ...base, settle: settleSpy };
    const cache = createInMemorySettlementCache();
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));

    const tool = createPaidMcpTool(config, { signer, facilitator, cache }, handler);
    const meta = { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("4") } };

    // Concurrent calls with the same payment settle only once.
    const [r1, r2] = await Promise.all([tool({}, meta), tool({}, meta)]);
    expect(r1._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toEqual(
      r2._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY],
    );
    expect(settleSpy).toHaveBeenCalledTimes(1);

    // Subsequent replay hits cache without settling again.
    const r3 = await tool({}, meta);
    expect(r3._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toEqual(
      r1._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY],
    );
    expect(settleSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched offers or malformed payment payloads before execution", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = createPaidMcpTool(
      config,
      { signer, facilitator: createMockFacilitator() },
      handler,
    );

    const badAmount = await tool(
      {},
      { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("5", { amount: "1" }) } },
    );
    expect(badAmount.isError).toBe(true);

    const malformed = await tool({}, { _meta: { [MCP_PAYMENT_META_KEY]: { bad: true } } });
    expect(malformed.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports cache write failures via onCacheError without hiding the settled receipt", async () => {
    const onCacheError = vi.fn();
    const failingCache = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error("redis down");
      },
    };
    const tool = createPaidMcpTool(
      config,
      {
        signer,
        facilitator: createMockFacilitator(),
        cache: failingCache,
        onCacheError,
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const res = await tool({}, { _meta: { [MCP_PAYMENT_META_KEY]: makePayment("6") } });
    expect(res.isError).toBeUndefined();
    expect(res._meta?.[MCP_TOLLWAY_RECEIPT_META_KEY]).toBeDefined();
    expect(onCacheError).toHaveBeenCalledTimes(1);
  });
});
