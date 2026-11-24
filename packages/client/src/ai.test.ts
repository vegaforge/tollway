import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  bytesToBase64Url,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPaidFetchTool, paidFetchInputSchema } from "./ai.js";
import { createMemoryReceiptStore } from "./receipt-store.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./x402-settler.js";

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

const RESOURCE = "https://api.example.com/data";
const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();

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
  amount: "2500",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};

function make402Response(override?: Partial<PaymentRequired>): Response {
  const pr: PaymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE, description: "Data endpoint", mimeType: "application/json" },
    accepts: [stellarExact],
    ...override,
  };
  return new Response("Payment Required", {
    status: 402,
    headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(pr) },
  });
}

async function makeSignedReceipt(
  override?: Partial<Parameters<typeof buildReceipt>[0]>,
): Promise<SignedReceipt> {
  const unsigned = buildReceipt({
    model: "x402",
    network: "testnet",
    payer: AGENT.publicKey(),
    payee: PAYEE,
    amount: "2500",
    asset: USDC,
    resource: RESOURCE,
    settlement: { kind: "transaction", txHash: "c".repeat(64) },
    issuedAt: new Date().toISOString(),
    ...override,
  });
  return signReceipt(unsigned, serviceSigner);
}

function encodeReceiptHeader(receipt: SignedReceipt): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(receipt)));
}

describe("createPaidFetchTool", () => {
  it("exposes AI SDK tool shape and renders guardrails in description", () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      allowedOrigins: ["https://api.example.com"],
      offerChecks: { maxAmount: { [USDC]: "10000" } },
      budgetDisplay: "10000 stroops daily",
    });

    expect(tool.inputSchema).toBe(paidFetchInputSchema);
    expect(tool.description).toContain("https://api.example.com");
    expect(tool.description).toContain("10000");
    expect(tool.description).toContain("10000 stroops daily");
    expect(typeof tool.execute).toBe("function");
  });

  it("fetches free URLs without paying", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
    });

    const res = await tool.execute({ url: RESOURCE });
    expect(res).toEqual({
      ok: true,
      status: 200,
      paid: false,
      body: JSON.stringify({ hello: "world" }),
      truncated: false,
      contentType: "application/json",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pays 402 challenge through Tollway and returns compact receipt summary", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const receipt = await makeSignedReceipt();
    const receiptStore = createMemoryReceiptStore();
    const policy = createPolicyEngine({ mode: "enforce", budget: { daily: "10000" } });

    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(make402Response())
      .mockResolvedValueOnce(
        new Response("secret-data", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            [TOLLWAY_RECEIPT_HEADER]: encodeReceiptHeader(receipt),
          },
        }),
      );

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      policy,
      verifier: serviceVerifier,
      receiptStore,
    });

    const res = await tool.execute({ url: RESOURCE, method: "GET" });
    expect(res.ok).toBe(true);
    expect(res.paid).toBe(true);
    if (res.paid) {
      expect(res.body).toBe("secret-data");
      expect(res.receipt.id).toBe(receipt.receipt.id);
      expect(res.receipt.amount).toBe("2500");
      expect(res.receipt.txHash).toBe("c".repeat(64));
      expect(res.receipt.deduplicated).toBe(false);
    }

    const paidInit = fetchMock.mock.calls[1]?.[1];
    expect((paidInit?.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER]).toBeDefined();
    expect((await receiptStore.query()).receipts).toHaveLength(1);
  });

  it("returns structured blocked result when policy budget is exceeded", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const policy = createPolicyEngine({ mode: "enforce", budget: { daily: "1000" } });
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(make402Response());

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      policy,
    });

    const res = await tool.execute({ url: RESOURCE });
    expect(res).toMatchObject({
      ok: false,
      blocked: true,
      paid: false,
      reason: "policy-blocked",
      errorCode: "policy-blocked",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns structured blocked result when offerChecks maxAmount is exceeded", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(make402Response());

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      offerChecks: { maxAmount: { [USDC]: "500" } },
    });

    const res = await tool.execute({ url: RESOURCE });
    expect(res).toMatchObject({
      ok: false,
      blocked: true,
      paid: false,
      reason: "offer-rejected",
      checkName: "maxAmount",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks disallowed origins before making any fetch call", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const fetchMock = vi.fn<typeof globalThis.fetch>();

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      allowedOrigins: ["https://trusted.example.com"],
    });

    const res = await tool.execute({ url: "https://evil.example.com/steal" });
    expect(res).toMatchObject({
      ok: false,
      blocked: true,
      paid: false,
      reason: "origin-not-allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks unsupported protocols and disallowed methods", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const fetchMock = vi.fn<typeof globalThis.fetch>();

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      allowedMethods: ["GET"],
    });

    const protoRes = await tool.execute({ url: "file:///etc/passwd" });
    expect(protoRes).toMatchObject({ ok: false, blocked: true, reason: "unsupported-protocol" });

    const methodRes = await tool.execute({ url: RESOURCE, method: "POST" });
    expect(methodRes).toMatchObject({ ok: false, blocked: true, reason: "method-not-allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates response body exceeding maxBodyBytes", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("abcdefghij", { status: 200 }),
    );

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      maxBodyBytes: 4,
    });

    const res = await tool.execute({ url: RESOURCE });
    expect(res).toMatchObject({
      ok: true,
      status: 200,
      paid: false,
      body: "abcd",
      truncated: true,
    });
  });

  it("forwards abortSignal to fetch", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
    });

    await tool.execute({ url: RESOURCE }, { abortSignal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("returns structured blocked result on invalid receipt signature", async () => {
    const signer = createEd25519Signer(AGENT.secret(), "stellar:testnet");
    const otherPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const otherSigner = new Ed25519Signer(otherPair.privateKey);
    const unsigned = buildReceipt({
      model: "x402",
      network: "testnet",
      payer: AGENT.publicKey(),
      payee: PAYEE,
      amount: "2500",
      asset: USDC,
      resource: RESOURCE,
      settlement: { kind: "transaction", txHash: "d".repeat(64) },
      issuedAt: new Date().toISOString(),
    });
    const forged = await signReceipt(unsigned, otherSigner);

    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(make402Response())
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { [TOLLWAY_RECEIPT_HEADER]: encodeReceiptHeader(forged) },
        }),
      );

    const tool = createPaidFetchTool({
      network: "testnet",
      signer,
      fetch: fetchMock,
      verifier: serviceVerifier,
    });

    const res = await tool.execute({ url: RESOURCE });
    expect(res).toMatchObject({
      ok: false,
      blocked: true,
      paid: false,
      reason: "receipt-verification-failed",
      errorCode: "receipt-verification-failed",
    });
  });
});
