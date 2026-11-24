import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  createDefaultRouter,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { Challenge } from "mppx";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPaidFetch } from "./paid-fetch.js";
import { TOLLWAY_RECEIPT_HEADER } from "./receipt-header.js";
import { createKeypairSigner, createSmartAccountSigner } from "./signer.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402-settler.js";

vi.mock("@x402/stellar/exact/client", async () => {
  const { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } =
    await vi.importActual<typeof import("@x402/stellar")>("@x402/stellar");
  const defaults: Record<string, string> = {
    "stellar:pubnet": USDC_PUBNET_ADDRESS,
    "stellar:testnet": USDC_TESTNET_ADDRESS,
  };
  return {
    ExactStellarScheme: class {
      readonly scheme = "exact";
      readonly findDefaultAsset = (asset: string, network: string) =>
        defaults[network] === asset ? { asset, decimals: 7, symbol: "USDC" } : undefined;
      constructor(
        readonly signer: { signAuthEntry: (entry: string) => Promise<{ signedAuthEntry: string }> },
      ) {}
      async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
        const { signedAuthEntry } = await this.signer.signAuthEntry(
          Buffer.from(`auth:${requirements.payTo}:${requirements.amount}`).toString("base64"),
        );
        return { x402Version, payload: { transaction: `signed:${signedAuthEntry}` } };
      }
    },
  };
});

vi.mock("@stellar/mpp/charge/client", () => ({
  stellar: {
    charge: () => ({
      name: "stellar",
      intent: "charge",
      async createCredential({ challenge }: { challenge: { id: string } }) {
        return `Payment id="${challenge.id}", method="stellar", credential="mock-cred"`;
      },
    }),
  },
}));

const RESOURCE = "https://api.example.com/quotes";
const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();

let serviceSigner: Ed25519Signer;
let verifier: Ed25519Verifier;

beforeAll(async () => {
  serviceSigner = await Ed25519Signer.generate("service-key");
  verifier = new Ed25519Verifier(await serviceSigner.publicJwk());
});

async function makeSignedReceipt(
  model: "x402" | "mpp-charge",
  payer: string,
): Promise<SignedReceipt> {
  return signReceipt(
    buildReceipt({
      resource: RESOURCE,
      amount: "10000",
      asset: USDC,
      payee: PAYEE,
      payer,
      network: "testnet",
      model,
      settlement: { kind: "tx", txHash: "a".repeat(64) },
    }),
    serviceSigner,
  );
}

function encodeReceipt(receipt: SignedReceipt): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

function make402X402(accepts?: PaymentRequirements[]): Response {
  const pr: PaymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: accepts ?? [
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: USDC,
        amount: "10000",
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
      },
    ],
  };
  return new Response(null, {
    status: 402,
    headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(pr) },
  });
}

describe("createPaidFetch (#201)", () => {
  it("passes through non-402 responses without touching policy or settlers", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const signer = createKeypairSigner({ keypair: AGENT, network: "testnet" });
    const paidFetch = createPaidFetch({ network: "testnet", signer, fetch: fetchMock });

    const res = await paidFetch(RESOURCE);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.receipt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pays an x402 V2 402 challenge in two total HTTP calls and returns Response + receipt", async () => {
    const receipt = await makeSignedReceipt("x402", AGENT.publicKey());
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(make402X402())
      .mockImplementationOnce(async (_input, init) => {
        const sig = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
        expect(sig).toBeTruthy();
        const decoded = decodePaymentSignatureHeader(sig as string);
        expect(decoded.x402Version).toBe(2);
        return new Response(JSON.stringify({ price: "1.23" }), {
          status: 200,
          headers: { [TOLLWAY_RECEIPT_HEADER]: encodeReceipt(receipt) },
        });
      });

    const policy = createPolicyEngine({ budgets: { daily: "50000" } });
    const signer = createKeypairSigner({ keypair: AGENT, network: "testnet" });
    const paidFetch = createPaidFetch({
      network: "testnet",
      signer,
      policy,
      verifier,
      fetch: fetchMock,
    });

    const res = await paidFetch(RESOURCE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: "1.23" });
    expect(res.model).toBe("x402");
    expect(res.receipt).toEqual(receipt);
    // Only 2 HTTP calls: initial 402 + paid retry (no duplicate unauthenticated GET).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves method, headers, and body on non-idempotent POST 402 retries", async () => {
    const receipt = await makeSignedReceipt("x402", AGENT.publicKey());
    const seenBodies: string[] = [];
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("POST");
        seenBodies.push(String(init?.body));
        return make402X402();
      })
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        expect(new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER)).toBeTruthy();
        seenBodies.push(String(init?.body));
        return new Response("created", {
          status: 201,
          headers: { [TOLLWAY_RECEIPT_HEADER]: encodeReceipt(receipt) },
        });
      });

    const signer = createKeypairSigner({ keypair: AGENT, network: "testnet" });
    const paidFetch = createPaidFetch({ network: "testnet", signer, verifier, fetch: fetchMock });

    const res = await paidFetch(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "XLM" }),
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("created");
    expect(seenBodies).toEqual(['{"query":"XLM"}', '{"query":"XLM"}']);
  });

  it("answers an MPP charge 402 challenge using Authorization header", async () => {
    const receipt = await makeSignedReceipt("mpp-charge", AGENT.publicKey());
    const challenge = Challenge.from({
      id: "chg-1",
      realm: "api.example.com",
      method: "stellar",
      intent: "charge",
      request: {
        amount: "10000",
        currency: USDC,
        recipient: PAYEE,
        methodDetails: { network: "stellar:testnet" },
      },
    });
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const auth = new Headers(init?.headers).get("Authorization");
        expect(auth).toMatch(/^Payment /);
        return new Response("mpp-ok", {
          status: 200,
          headers: { [TOLLWAY_RECEIPT_HEADER]: encodeReceipt(receipt) },
        });
      });

    const signer = createKeypairSigner({ keypair: AGENT, network: "testnet" });
    const paidFetch = createPaidFetch({
      network: "testnet",
      signer,
      verifier,
      router: createDefaultRouter({ defaultModel: "mpp-charge" }),
      fetch: fetchMock,
    });

    const res = await paidFetch(RESOURCE);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mpp-ok");
    expect(res.model).toBe("mpp-charge");
    expect(res.receipt).toEqual(receipt);
  });

  it("stops before signing when the policy blocks the spend", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(make402X402());
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const signer = createKeypairSigner({ keypair: AGENT, network: "testnet" });
    const paidFetch = createPaidFetch({ network: "testnet", signer, policy, fetch: fetchMock });

    await expect(paidFetch(RESOURCE)).rejects.toThrow(TollwayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports smart-account signers for x402 and rejects MPP-only challenges", async () => {
    const contract = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const smartSigner = createSmartAccountSigner({
      address: contract,
      network: "testnet",
      signAuthEntry: async (entry) => ({ signedAuthEntry: `smart:${entry}` }),
    });
    const receipt = await makeSignedReceipt("x402", contract);
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(make402X402())
      .mockResolvedValueOnce(
        new Response("smart-ok", {
          status: 200,
          headers: { [TOLLWAY_RECEIPT_HEADER]: encodeReceipt(receipt) },
        }),
      );

    const paidFetch = createPaidFetch({
      network: "testnet",
      signer: smartSigner,
      verifier,
      fetch: fetchMock,
    });
    const res = await paidFetch(RESOURCE);
    expect(await res.text()).toBe("smart-ok");
    expect(res.receipt?.payer).toBe(contract);

    const challenge = Challenge.from({
      id: "chg-2",
      realm: "api.example.com",
      method: "stellar",
      intent: "charge",
      request: {
        amount: "10000",
        currency: USDC,
        recipient: PAYEE,
        methodDetails: { network: "stellar:testnet" },
      },
    });
    const mppOnlyFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
      }),
    );
    const smartMpp = createPaidFetch({
      network: "testnet",
      signer: smartSigner,
      fetch: mppOnlyFetch,
    });
    await expect(smartMpp(RESOURCE)).rejects.toThrow(/requires a keypair signer/);
  });
});
