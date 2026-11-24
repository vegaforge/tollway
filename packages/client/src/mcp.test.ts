import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  bytesToBase64Url,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTollwayMcpClient,
  extractPaymentRequired,
  type McpClientLike,
  type McpToolResult,
  TOLLWAY_MCP_RECEIPT_META_KEY,
  X402_MCP_PAYMENT_META_KEY,
} from "./mcp.js";
import { createMemoryReceiptStore } from "./receipt-store.js";

vi.mock("@x402/stellar/exact/client", () => {
  return {
    ExactStellarScheme: class {
      readonly scheme = "exact";
      constructor(
        readonly signer: { signAuthEntry: (entry: string) => Promise<{ signedAuthEntry: string }> },
      ) {}
      async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
        const { signedAuthEntry } = await this.signer.signAuthEntry(
          Buffer.from(`auth:${requirements.payTo}:${requirements.amount}`).toString("base64"),
        );
        return {
          x402Version,
          accepted: requirements,
          payload: { transaction: `signed:${signedAuthEntry}` },
        };
      }
    },
  };
});

const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();
const RESOURCE = "mcp://tools/weather";

let serviceSigner: Ed25519Signer;
let serviceVerifier: Ed25519Verifier;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  serviceSigner = new Ed25519Signer(pair.privateKey);
  serviceVerifier = new Ed25519Verifier(pair.publicKey);
});

const stellarExact: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "5000",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};

function makeChallenge(override?: Partial<PaymentRequired>): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, description: "Weather lookup", mimeType: "application/json" },
    accepts: [stellarExact],
    ...override,
  };
}

async function makeSignedReceipt(
  override?: Partial<Parameters<typeof buildReceipt>[0]>,
): Promise<SignedReceipt> {
  const unsigned = buildReceipt({
    model: "x402",
    network: "testnet",
    payer: AGENT.publicKey(),
    payee: PAYEE,
    amount: "5000",
    asset: USDC,
    resource: RESOURCE,
    settlement: {
      kind: "transaction",
      txHash: "a".repeat(64),
    },
    issuedAt: new Date().toISOString(),
    ...override,
  });
  return signReceipt(unsigned, serviceSigner);
}

describe("createTollwayMcpClient", () => {
  it("passes through free tool calls without paying", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValue({
      content: [{ type: "text", text: "sunny" }],
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
    });

    const res = await mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });
    expect(res.paid).toBe(false);
    expect(res.receipt).toBeUndefined();
    expect(res.result.content[0]?.text).toBe("sunny");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("passes through non-payment tool errors without paying", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "city not found" }],
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
    });

    const res = await mcp.callTool({ name: "weather", arguments: { city: "Nowhere" } });
    expect(res.paid).toBe(false);
    expect(res.result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("intercepts x402 PaymentRequired, enforces policy, pays, and returns verified receipt", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const receipt = await makeSignedReceipt();
    const receiptStore = createMemoryReceiptStore();
    const policy = createPolicyEngine({
      mode: "enforce",
      budget: { daily: "10000" },
    });

    const callTool = vi
      .fn<McpClientLike["callTool"]>()
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: "text", text: "Payment required" }],
        structuredContent: makeChallenge() as unknown as Record<string, unknown>,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "28C" }],
        _meta: {
          [TOLLWAY_MCP_RECEIPT_META_KEY]: receipt,
        },
      });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      policy,
      verifier: serviceVerifier,
      receiptStore,
    });

    const events: string[] = [];
    mcp.on((e) => events.push(e.type));

    const res = await mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });
    expect(res.paid).toBe(true);
    expect(res.model).toBe("x402");
    expect(res.receipt).toEqual(receipt);
    expect(res.result.content[0]?.text).toBe("28C");
    expect(callTool).toHaveBeenCalledTimes(2);

    const retryArgs = callTool.mock.calls[1]?.[0];
    expect(retryArgs?._meta?.[X402_MCP_PAYMENT_META_KEY]).toBeDefined();
    expect(events).toContain("policy:decision");
    expect(events).toContain("payment");

    const stored = await receiptStore.query();
    expect(stored.receipts).toHaveLength(1);
  });

  it("supports base64-encoded Tollway receipt in _meta", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const receipt = await makeSignedReceipt();
    const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(receipt)));

    const callTool = vi
      .fn<McpClientLike["callTool"]>()
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(makeChallenge()) }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: encoded },
      });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      verifier: serviceVerifier,
    });

    const res = await mcp.callTool({ name: "weather" });
    expect(res.paid).toBe(true);
    expect(res.receipt).toEqual(receipt);
  });

  it("blocks payment when policy budget is exceeded without calling retry", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const policy = createPolicyEngine({
      mode: "enforce",
      budget: { daily: "1000" },
    });

    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValueOnce({
      isError: true,
      content: [],
      structuredContent: makeChallenge() as unknown as Record<string, unknown>,
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      policy,
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toMatchObject({
      code: "policy-blocked",
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects offer failing offerChecks before signing", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const signPayment = vi.fn<() => Promise<PaymentPayload>>();

    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValueOnce({
      isError: true,
      content: [],
      structuredContent: makeChallenge() as unknown as Record<string, unknown>,
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      signPayment,
      offerChecks: { maxAmount: { [USDC]: "1000" } },
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toMatchObject({
      code: "offer-rejected",
    });
    expect(signPayment).not.toHaveBeenCalled();
  });

  it("respects onPaymentRequested returning false", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValueOnce({
      isError: true,
      content: [],
      structuredContent: makeChallenge() as unknown as Record<string, unknown>,
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      onPaymentRequested: () => false,
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toMatchObject({
      code: "policy-blocked",
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects missing receipt in _meta", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const callTool = vi
      .fn<McpClientLike["callTool"]>()
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: makeChallenge() as unknown as Record<string, unknown>,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toMatchObject({
      code: "invalid-receipt",
    });
  });

  it("rejects forged receipt when verifier is configured", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const otherPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const otherSigner = new Ed25519Signer(otherPair.privateKey);
    const unsigned = buildReceipt({
      model: "x402",
      network: "testnet",
      payer: AGENT.publicKey(),
      payee: PAYEE,
      amount: "5000",
      asset: USDC,
      resource: RESOURCE,
      settlement: { kind: "transaction", txHash: "b".repeat(64) },
      issuedAt: new Date().toISOString(),
    });
    const forged = await signReceipt(unsigned, otherSigner);

    const callTool = vi
      .fn<McpClientLike["callTool"]>()
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: makeChallenge() as unknown as Record<string, unknown>,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: forged },
      });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      verifier: serviceVerifier,
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toMatchObject({
      code: "receipt-verification-failed",
    });
  });

  it("extracts PaymentRequired from _meta['x402/payment-required']", () => {
    const challenge = makeChallenge();
    const res: McpToolResult = {
      isError: true,
      content: [],
      _meta: { "x402/payment-required": challenge },
    };
    expect(extractPaymentRequired(res)).toEqual(challenge);
  });

  it("throws TypeError when neither signer nor signPayment is provided", () => {
    expect(() =>
      createTollwayMcpClient({
        client: { callTool: vi.fn() },
        network: "testnet",
      }),
    ).toThrow(TypeError);
  });

  it("retries with fresh auth when server answers paid call with another PaymentRequired", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const receipt = await makeSignedReceipt();
    const challenge = makeChallenge();

    const callTool = vi
      .fn<McpClientLike["callTool"]>()
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: challenge as unknown as Record<string, unknown>,
      })
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: challenge as unknown as Record<string, unknown>,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "recovered" }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: receipt },
      });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
      verifier: serviceVerifier,
    });

    const res = await mcp.callTool({ name: "weather" });
    expect(res.paid).toBe(true);
    expect(res.result.content[0]?.text).toBe("recovered");
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("throws TollwayError when no matching Stellar option exists", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const callTool = vi.fn<McpClientLike["callTool"]>().mockResolvedValueOnce({
      isError: true,
      content: [],
      structuredContent: makeChallenge({
        accepts: [{ ...stellarExact, network: "eip155:8453" }],
      }) as unknown as Record<string, unknown>,
    });

    const mcp = createTollwayMcpClient({
      client: { callTool },
      network: "testnet",
      signer,
    });

    await expect(mcp.callTool({ name: "weather" })).rejects.toBeInstanceOf(TollwayError);
  });
});
