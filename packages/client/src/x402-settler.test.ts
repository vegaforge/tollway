import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./index.js";
import {
  createX402Settler,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./x402-settler.js";

// ExactStellarScheme simulates the transfer against Soroban RPC, so it is
// stubbed at its module boundary. The stub still signs with the real
// signer it is given, so the test covers the real createEd25519Signer
// path over a random testnet key pair, with no network.
const scheme = vi.hoisted(() => ({
  constructed: [] as Array<{ signer: unknown; rpcConfig: unknown }>,
  createPaymentPayload: vi.fn(),
}));

vi.mock("@x402/stellar/exact/client", () => ({
  ExactStellarScheme: class {
    readonly scheme = "exact";
    constructor(
      readonly signer: { signAuthEntry: (entry: string) => Promise<{ signedAuthEntry: string }> },
      rpcConfig?: unknown,
    ) {
      scheme.constructed.push({ signer, rpcConfig });
    }
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
      scheme.createPaymentPayload(x402Version, requirements);
      const { signedAuthEntry } = await this.signer.signAuthEntry(
        Buffer.from(`auth-entry:${requirements.payTo}:${requirements.amount}`).toString("base64"),
      );
      return { x402Version, payload: { transaction: `signed-tx:${signedAuthEntry}` } };
    }
  },
}));

const RESOURCE = "https://api.example.com/quotes/latest";
const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();

const offer: PaymentOffer = {
  resource: RESOURCE,
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  network: "testnet",
  models: ["x402"],
};

const stellarExact: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: USDC,
  amount: "10000",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

function paymentRequired(accepts: PaymentRequirements[] = [stellarExact]): PaymentRequired {
  return { x402Version: 2, resource: { url: RESOURCE }, accepts };
}

let serviceSigner: Ed25519Signer;
let receipt: SignedReceipt;

beforeAll(async () => {
  serviceSigner = await Ed25519Signer.generate("service-key");
  receipt = await signReceipt(
    buildReceipt({
      payer: AGENT.publicKey(),
      payee: PAYEE,
      amount: "10000",
      asset: USDC,
      resource: RESOURCE,
      model: "x402",
      settlement: { kind: "transaction", txHash: "d".repeat(64) },
      network: "testnet",
    }),
    serviceSigner,
  );
});

beforeEach(() => {
  scheme.constructed.length = 0;
  scheme.createPaymentPayload.mockClear();
});

function receiptHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** A fetch that answers each call with the next scripted response. */
function scriptedFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function challenge(required: PaymentRequired = paymentRequired()): Response {
  return new Response(null, {
    status: 402,
    headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(required) },
  });
}

function paid(
  headers: Record<string, string> = { [TOLLWAY_RECEIPT_HEADER]: receiptHeader(receipt) },
) {
  return new Response("ok", { status: 200, headers });
}

function settler(fetch: typeof globalThis.fetch) {
  return createX402Settler({
    signer: createEd25519Signer(AGENT.secret(), "stellar:testnet"),
    network: "testnet",
    fetch,
  });
}

describe("createX402Settler", () => {
  it("plays 402 then 200: signs the Stellar exact option and returns the receipt", async () => {
    const { fetch, calls } = scriptedFetch(challenge(), paid());

    const result = await settler(fetch).settle({ resource: RESOURCE, offer, model: "x402" });

    expect(result).toEqual(receipt);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(2, stellarExact);

    const sent = (calls[1]?.init?.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER];
    const decoded = decodePaymentSignatureHeader(sent ?? "");
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(stellarExact);
    expect(decoded.payload.transaction).toMatch(/^signed-tx:.+/);
  });

  it("works end to end through createClient with receipt verification", async () => {
    const { fetch } = scriptedFetch(challenge(), paid());
    const client = createClient({
      network: "testnet",
      settler: settler(fetch),
      verifier: Ed25519Verifier.forSigner(serviceSigner),
    });
    const result = await client.pay({ resource: RESOURCE, offer });
    expect(result.model).toBe("x402");
    expect(result.receipt.receipt.id).toBe(receipt.receipt.id);
  });

  it("picks the Stellar exact option when the 402 lists others first", async () => {
    const evm: PaymentRequirements = { ...stellarExact, network: "eip155:8453", asset: "0xabc" };
    const { fetch } = scriptedFetch(challenge(paymentRequired([evm, stellarExact])), paid());
    await settler(fetch).settle({ resource: RESOURCE, offer, model: "x402" });
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(2, stellarExact);
  });

  it("keeps the secret off the settler object", () => {
    const { fetch } = scriptedFetch();
    const created = settler(fetch);
    expect(JSON.stringify(created)).not.toContain(AGENT.secret());
    expect(Object.keys(created)).toEqual(["settle"]);
  });

  it("passes a custom RPC URL to the scheme", () => {
    const { fetch } = scriptedFetch();
    createX402Settler({
      signer: createEd25519Signer(AGENT.secret(), "stellar:testnet"),
      network: "testnet",
      fetch,
      rpcUrl: "https://rpc.example",
    });
    expect(scheme.constructed[0]?.rpcConfig).toEqual({ url: "https://rpc.example" });
  });

  describe("rejections", () => {
    async function rejection(fetch: typeof globalThis.fetch, request = offer) {
      const error = await settler(fetch)
        .settle({ resource: RESOURCE, offer: request, model: "x402" })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(TollwayError);
      return error as TollwayError;
    }

    it("rejects a first response that is not a 402", async () => {
      const { fetch } = scriptedFetch(new Response("free", { status: 200 }));
      const error = await rejection(fetch);
      expect(error.code).toBe("payment-failed");
      expect(error.message).toBe(`expected a 402 challenge from ${RESOURCE}, got 200`);
    });

    it("rejects a 402 with no PAYMENT-REQUIRED header", async () => {
      const { fetch } = scriptedFetch(new Response(null, { status: 402 }));
      const error = await rejection(fetch);
      expect(error.message).toBe(`the 402 from ${RESOURCE} has no PAYMENT-REQUIRED header`);
    });

    it("rejects a 402 with no Stellar exact option", async () => {
      const upto: PaymentRequirements = { ...stellarExact, scheme: "upto" };
      const mainnet: PaymentRequirements = { ...stellarExact, network: "stellar:pubnet" };
      const { fetch } = scriptedFetch(challenge(paymentRequired([upto, mainnet])));
      const error = await rejection(fetch);
      expect(error.message).toBe(
        `the 402 from ${RESOURCE} has no Stellar exact option for stellar:testnet`,
      );
      expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
    });

    it("rejects a 402 that asks for more than the approved offer, before signing", async () => {
      const { fetch } = scriptedFetch(
        challenge(paymentRequired([{ ...stellarExact, amount: "99999" }])),
      );
      const error = await rejection(fetch);
      expect(error.message).toBe(
        `the 402 from ${RESOURCE} asks for 99999, but the offer was 10000`,
      );
      expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
    });

    it("rejects a 402 that pays someone other than the offer's payee", async () => {
      const other = Keypair.random().publicKey();
      const { fetch } = scriptedFetch(
        challenge(paymentRequired([{ ...stellarExact, payTo: other }])),
      );
      const error = await rejection(fetch);
      expect(error.message).toContain(`pays ${other}`);
    });

    it("rejects a second 402", async () => {
      const { fetch } = scriptedFetch(challenge(), challenge());
      const error = await rejection(fetch);
      expect(error.message).toBe(`${RESOURCE} answered the signed payment with another 402`);
    });

    it("rejects another failure status after paying", async () => {
      const { fetch } = scriptedFetch(challenge(), new Response(null, { status: 500 }));
      const error = await rejection(fetch);
      expect(error.message).toBe(`${RESOURCE} answered the signed payment with 500`);
    });

    it("rejects a paid response with no receipt header", async () => {
      const { fetch } = scriptedFetch(challenge(), paid({}));
      const error = await rejection(fetch);
      expect(error.code).toBe("invalid-receipt");
      expect(error.message).toBe(
        `${RESOURCE} settled the payment but sent no TOLLWAY-RECEIPT header`,
      );
    });

    it("rejects a receipt header that is not a Tollway receipt", async () => {
      const { fetch } = scriptedFetch(
        challenge(),
        paid({ [TOLLWAY_RECEIPT_HEADER]: receiptHeader({ hello: "world" }) }),
      );
      const error = await rejection(fetch);
      expect(error.message).toBe(
        `the TOLLWAY-RECEIPT header from ${RESOURCE} is not a Tollway receipt`,
      );
    });

    it("refuses a model other than x402 without any request", async () => {
      const { fetch, calls } = scriptedFetch();
      await expect(
        settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
      ).rejects.toThrow('the x402 settler cannot settle model "mpp-charge"');
      expect(calls).toHaveLength(0);
    });
  });
});
