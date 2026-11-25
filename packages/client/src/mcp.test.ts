import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ClientEvent,
  OfferRejectedError,
  PolicyBlockedError,
  ReceiptVerificationError,
} from "./index.js";
import {
  createTollwayMcpClient,
  extractPaymentRequired,
  type McpPaymentSignInput,
  TOLLWAY_MCP_RECEIPT_META_KEY,
  type TollwayMcpClientOptions,
  X402_MCP_PAYMENT_META_KEY,
  X402_MCP_PAYMENT_RESPONSE_META_KEY,
} from "./mcp.js";
import { createMemoryReceiptStore } from "./receipt-store.js";

// The x402 Stellar scheme simulates the auth entry against Soroban RPC. The
// one test that goes through it swaps in a scheme that signs locally, so the
// suite never reaches the network.
vi.mock("@x402/stellar/exact/client", () => ({
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
        payload: { transaction: `signed:${signedAuthEntry}` },
      };
    }
  },
}));

const PAYEE = Keypair.random().publicKey();
const AGENT = Keypair.random();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const RESOURCE = "mcp://tool/weather";

let serviceSigner: Ed25519Signer;
let serviceVerifier: Ed25519Verifier;
let forgerSigner: Ed25519Signer;

beforeAll(async () => {
  serviceSigner = await Ed25519Signer.generate("weather-service");
  serviceVerifier = Ed25519Verifier.forSigner(serviceSigner);
  // Same key id, different key: a receipt that claims to be the service's.
  forgerSigner = await Ed25519Signer.generate("weather-service");
});

const exactOption: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "5000",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};

function challenge(amount = "5000"): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: RESOURCE, description: "Weather lookup" },
    accepts: [{ ...exactOption, amount }],
  };
}

async function receiptFor(
  amount = "5000",
  signer: Ed25519Signer = serviceSigner,
): Promise<SignedReceipt> {
  return signReceipt(
    buildReceipt({
      model: "x402",
      network: "testnet",
      payer: AGENT.publicKey(),
      payee: PAYEE,
      amount,
      asset: USDC,
      resource: RESOURCE,
      settlement: { kind: "transaction", txHash: "a".repeat(64) },
      issuedAt: new Date().toISOString(),
    }),
    signer,
  );
}

/** Signs nothing on chain: the payload names the accepted option and a marker. */
function fakeSignPayment({ paymentRequired, requirements }: McpPaymentSignInput) {
  return Promise.resolve<PaymentPayload>({
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: { transaction: "signed-by-test" },
  });
}

type PaidToolBehaviour = {
  /** What the tool sends back to a paid call. Defaults to a verified result. */
  afterPayment?: (city: string) => Promise<{
    isError?: boolean;
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>;
  /** Delays the paid answer, to hold two calls in flight at once. */
  paidDelayMs?: number;
};

type Harness = {
  client: Client;
  /** Payloads the tool received, in order. */
  payments: unknown[];
  /** Cities each paid call was answered for. */
  paidCities: string[];
};

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

/**
 * A real MCP server and client joined by the SDK's in-memory transport. The
 * `weather` tool follows the x402 MCP transport: an unpaid call gets
 * `isError: true` with `PaymentRequired` in `structuredContent` and in the
 * first text block, and a paid call carries `_meta["x402/payment"]`.
 */
async function startServer(behaviour: PaidToolBehaviour = {}): Promise<Harness> {
  const server = new McpServer({ name: "paid-weather", version: "1.0.0" });
  const payments: unknown[] = [];
  const paidCities: string[] = [];

  server.registerTool(
    "weather",
    { description: "Paid weather lookup", inputSchema: { city: z.string() } },
    async ({ city }, extra) => {
      const payment = extra._meta?.[X402_MCP_PAYMENT_META_KEY];
      if (payment === undefined) {
        const body = challenge();
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(body) }],
          structuredContent: body,
        };
      }
      payments.push(payment);
      if (behaviour.paidDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.paidDelayMs));
      }
      paidCities.push(city);
      if (behaviour.afterPayment) return behaviour.afterPayment(city);
      return {
        content: [{ type: "text", text: `sunny in ${city}` }],
        _meta: {
          [X402_MCP_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: "a".repeat(64) },
          [TOLLWAY_MCP_RECEIPT_META_KEY]: await receiptFor(),
        },
      };
    },
  );

  server.registerTool("broken", { description: "Always fails" }, async () => ({
    isError: true,
    content: [{ type: "text", text: "upstream weather service is down" }],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openClients.push(client);
  return { client, payments, paidCities };
}

function wrap(client: Client, options: Partial<TollwayMcpClientOptions> = {}) {
  return createTollwayMcpClient({
    client,
    network: "testnet",
    payer: AGENT.publicKey(),
    signPayment: fakeSignPayment,
    verifier: serviceVerifier,
    ...options,
  });
}

function textOf(result: { content: unknown[] }): string | undefined {
  const first = result.content[0];
  if (typeof first === "object" && first !== null && "text" in first) {
    return typeof first.text === "string" ? first.text : undefined;
  }
  return undefined;
}

describe("createTollwayMcpClient over a real MCP transport", () => {
  it("pays a payment-required tool, retries with the payment, and returns the verified receipt", async () => {
    const harness = await startServer();
    const store = createMemoryReceiptStore();
    const mcp = wrap(harness.client, { receiptStore: store });

    const call = await mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });

    expect(call.paid).toBe(true);
    expect(textOf(call.result)).toBe("sunny in Lagos");
    expect(call.receipt?.receipt.amount).toBe("5000");
    expect(call.receipt?.receipt.resource).toBe(RESOURCE);
    expect(harness.payments).toHaveLength(1);
    expect(harness.payments[0]).toMatchObject({ accepted: { amount: "5000", payTo: PAYEE } });
    const stored = await store.query({});
    expect(stored.items.map((r) => r.receipt.id)).toEqual([call.receipt?.receipt.id]);
  });

  it("passes a free tool result through untouched", async () => {
    const server = new McpServer({ name: "free", version: "1.0.0" });
    server.registerTool("echo", { inputSchema: { word: z.string() } }, async ({ word }) => ({
      content: [{ type: "text", text: word }],
    }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "1.0.0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    openClients.push(client);
    const signPayment = vi.fn(fakeSignPayment);

    const call = await wrap(client, { signPayment }).callTool({
      name: "echo",
      arguments: { word: "hi" },
    });

    expect(call.paid).toBe(false);
    expect(textOf(call.result)).toBe("hi");
    expect(signPayment).not.toHaveBeenCalled();
  });

  it("passes a tool error that is not a payment request through unchanged without paying", async () => {
    const harness = await startServer();
    const signPayment = vi.fn(fakeSignPayment);

    const call = await wrap(harness.client, { signPayment }).callTool({ name: "broken" });

    expect(call.paid).toBe(false);
    expect(call.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "upstream weather service is down" }],
    });
    expect(signPayment).not.toHaveBeenCalled();
  });

  it("rejects with PolicyBlockedError, emits skip, and never sends the payment when policy blocks", async () => {
    const harness = await startServer();
    const policy = createPolicyEngine({ budgets: { daily: "1000" } });
    const mcp = wrap(harness.client, { policy });
    const events: ClientEvent[] = [];
    mcp.on((event) => events.push(event));

    const call = mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });

    await expect(call).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(events.some((event) => event.type === "skip" && event.resource === RESOURCE)).toBe(true);
    expect(harness.payments).toHaveLength(0);
  });

  it("rejects an offer over the per-call ceiling before signing", async () => {
    const harness = await startServer();
    const signPayment = vi.fn(fakeSignPayment);
    const mcp = wrap(harness.client, {
      signPayment,
      offerChecks: { maxAmount: { [USDC]: "100" } },
    });

    await expect(
      mcp.callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toBeInstanceOf(OfferRejectedError);
    expect(signPayment).not.toHaveBeenCalled();
    expect(harness.payments).toHaveLength(0);
  });

  it("rejects a forged receipt when a verifier is configured", async () => {
    const harness = await startServer({
      afterPayment: async (city) => ({
        content: [{ type: "text", text: `sunny in ${city}` }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: await receiptFor("5000", forgerSigner) },
      }),
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toBeInstanceOf(ReceiptVerificationError);
  });

  it("rejects a receipt for a different amount than the offer", async () => {
    const harness = await startServer({
      afterPayment: async (city) => ({
        content: [{ type: "text", text: `sunny in ${city}` }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: await receiptFor("4000") },
      }),
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toMatchObject({ code: "receipt-offer-mismatch" });
  });

  it("rejects a paid result that carries no receipt", async () => {
    const harness = await startServer({
      afterPayment: async (city) => ({ content: [{ type: "text", text: `sunny in ${city}` }] }),
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toMatchObject({ code: "invalid-receipt" });
  });

  it("rejects a receipt sent as a string instead of the receipt object", async () => {
    const harness = await startServer({
      afterPayment: async (city) => ({
        content: [{ type: "text", text: `sunny in ${city}` }],
        _meta: { [TOLLWAY_MCP_RECEIPT_META_KEY]: JSON.stringify(await receiptFor()) },
      }),
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toMatchObject({ code: "invalid-receipt" });
  });

  it("rejects a second payment request after paying when retries are off", async () => {
    const harness = await startServer({
      afterPayment: async () => {
        const body = challenge();
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(body) }],
          structuredContent: body,
        };
      },
    });

    await expect(
      wrap(harness.client, { retry: { maxAttempts: 1 } }).callTool({
        name: "weather",
        arguments: { city: "Lagos" },
      }),
    ).rejects.toMatchObject({ code: "payment-failed" });
    expect(harness.payments).toHaveLength(1);
  });

  it("pays at most twice under the default retry policy when the tool keeps asking", async () => {
    const harness = await startServer({
      afterPayment: async () => {
        const body = challenge();
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(body) }],
          structuredContent: body,
        };
      },
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toThrow();
    expect(harness.payments).toHaveLength(2);
  });

  it("refuses to sign a retry whose price changed from the first attempt", async () => {
    let answered = 0;
    const harness = await startServer({
      afterPayment: async (city) => {
        answered += 1;
        if (answered === 1) {
          const body = challenge("9000");
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(body) }],
            structuredContent: body,
          };
        }
        return { content: [{ type: "text", text: `sunny in ${city}` }] };
      },
    });

    await expect(
      wrap(harness.client).callTool({ name: "weather", arguments: { city: "Lagos" } }),
    ).rejects.toThrow(/changed between attempts/);
    expect(harness.payments).toHaveLength(1);
  });

  it("keeps concurrent paid calls to one tool apart: each pays and gets its own result", async () => {
    const harness = await startServer({ paidDelayMs: 20 });
    const mcp = wrap(harness.client);

    const [lagos, accra] = await Promise.all([
      mcp.callTool({ name: "weather", arguments: { city: "Lagos" } }),
      mcp.callTool({ name: "weather", arguments: { city: "Accra" } }),
    ]);

    expect(textOf(lagos.result)).toBe("sunny in Lagos");
    expect(textOf(accra.result)).toBe("sunny in Accra");
    expect(lagos.deduplicated).toBe(false);
    expect(accra.deduplicated).toBe(false);
    expect(harness.paidCities.sort()).toEqual(["Accra", "Lagos"]);
  });

  it("denies the payment with PolicyBlockedError and a skip event when onPaymentRequested refuses", async () => {
    const harness = await startServer();
    const mcp = wrap(harness.client, { onPaymentRequested: () => false });
    const events: ClientEvent[] = [];
    mcp.on((event) => events.push(event));

    const call = mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });

    await expect(call).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(call).rejects.toMatchObject({ rule: "onPaymentRequested" });
    expect(events).toContainEqual(expect.objectContaining({ type: "skip", resource: RESOURCE }));
    expect(harness.payments).toHaveLength(0);
  });

  it("signs with the x402 Stellar scheme when given a signer", async () => {
    const harness = await startServer();
    const mcp = createTollwayMcpClient({
      client: harness.client,
      network: "testnet",
      signer: createEd25519Signer(AGENT.secret(), "stellar:testnet"),
      verifier: serviceVerifier,
    });

    const call = await mcp.callTool({ name: "weather", arguments: { city: "Lagos" } });

    expect(call.paid).toBe(true);
    expect(harness.payments[0]).toMatchObject({
      x402Version: 2,
      accepted: { amount: "5000", payTo: PAYEE },
    });
  });

  it("throws when neither a signer nor signPayment is given", () => {
    expect(() =>
      createTollwayMcpClient({
        client: { callTool: async () => ({ content: [] }) },
        network: "testnet",
      }),
    ).toThrow(TypeError);
  });
});

describe("extractPaymentRequired", () => {
  it("reads the challenge from structuredContent", () => {
    expect(
      extractPaymentRequired({ isError: true, content: [], structuredContent: challenge() }),
    ).toMatchObject({ x402Version: 2, resource: { url: RESOURCE } });
  });

  it("reads the challenge from the first text block", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(challenge()) }],
    };
    expect(extractPaymentRequired(result)).toMatchObject({ x402Version: 2 });
  });

  it("ignores a challenge in a later text block, as the transport only defines the first", () => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: "something went wrong" },
        { type: "text", text: JSON.stringify(challenge()) },
      ],
    };
    expect(extractPaymentRequired(result)).toBeUndefined();
  });

  it("ignores _meta['x402/payment-required'], which the x402 MCP transport does not define", () => {
    const result = { isError: true, content: [], _meta: { "x402/payment-required": challenge() } };
    expect(extractPaymentRequired(result)).toBeUndefined();
  });

  it("ignores a result that is not an error", () => {
    expect(extractPaymentRequired({ content: [], structuredContent: challenge() })).toBeUndefined();
  });

  it("rejects a challenge that fails the x402 V2 schema", () => {
    const malformed = { ...challenge(), accepts: [{ ...exactOption, amount: 5000 }] };
    expect(
      extractPaymentRequired({ isError: true, content: [], structuredContent: malformed }),
    ).toBeUndefined();
  });

  it("rejects a challenge without a resource, so the offer always names the tool resource", () => {
    const { resource: _resource, ...withoutResource } = challenge();
    expect(
      extractPaymentRequired({ isError: true, content: [], structuredContent: withoutResource }),
    ).toBeUndefined();
  });
});
