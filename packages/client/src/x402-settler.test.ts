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
import { SettlementOutcomeError } from "./retry.js";
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

vi.mock("@x402/stellar/exact/client", async () => {
  const { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } =
    await vi.importActual<typeof import("@x402/stellar")>("@x402/stellar");
  // The 2.31 scheme exposes findDefaultAsset, which x402Client's default
  // spend controls use to recognise USDC and apply the $1 cap. The stub keeps
  // the same lookup (dist/cjs/exact/client/index.js, DEFAULT_ASSETS) so those
  // controls run here exactly as they would against the real scheme.
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
  };
});

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

  // @x402/core 2.31 caps default assets at $1 and refuses other assets unless
  // told otherwise. The offer the policy engine approved is the limit instead.
  it("pays an approved offer above x402's default $1 cap", async () => {
    const large: PaymentRequirements = { ...stellarExact, amount: "500000000" };
    const { fetch } = scriptedFetch(challenge(paymentRequired([large])), paid());
    await settler(fetch).settle({
      resource: RESOURCE,
      offer: { ...offer, amount: "500000000" },
      model: "x402",
    });
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(2, large);
  });

  it("pays an approved offer in an asset x402 does not recognise", async () => {
    const token = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    const custom: PaymentRequirements = { ...stellarExact, asset: token };
    const { fetch } = scriptedFetch(challenge(paymentRequired([custom])), paid());
    await settler(fetch).settle({
      resource: RESOURCE,
      offer: { ...offer, asset: token },
      model: "x402",
    });
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(2, custom);
  });

  it("keeps the secret off the settler object", () => {
    const { fetch } = scriptedFetch();
    const created = settler(fetch);
    expect(JSON.stringify(created)).not.toContain(AGENT.secret());
    expect(Object.keys(created).sort()).toEqual(["payer", "settle"]);
    // The payer is the public address, which the client checks receipts against.
    expect(created.payer).toBe(AGENT.publicKey());
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

    it("reports a signing failure as a Tollway payment failure", async () => {
      scheme.createPaymentPayload.mockImplementationOnce(() => {
        throw new Error("Stellar simulation failed");
      });
      const { fetch, calls } = scriptedFetch(challenge());
      const error = await rejection(fetch);
      expect(error.code).toBe("payment-failed");
      expect(error.message).toBe(
        `could not sign the x402 payment for ${RESOURCE}: Stellar simulation failed`,
      );
      expect(calls).toHaveLength(1);
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

describe("createX402Settler outcome classification (issue #203)", () => {
  async function outcome(
    fetch: typeof globalThis.fetch,
    extra: { pinned?: { amount: string; asset: string; payTo: string } } = {},
  ): Promise<SettlementOutcomeError> {
    const error = await settler(fetch)
      .settle({ resource: RESOURCE, offer, model: "x402", ...extra })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(SettlementOutcomeError);
    return error as SettlementOutcomeError;
  }

  it("classifies a second 402 as retryable and names the terms it signed", async () => {
    const { fetch } = scriptedFetch(challenge(), challenge());
    const error = await outcome(fetch);
    expect(error.kind).toBe("retryable-with-fresh-auth");
    expect(error.code).toBe("payment-failed");
    expect(error.signedTerms).toEqual({ amount: "10000", asset: USDC, payTo: PAYEE });
  });

  it("resends the identical payment header for a 409 with Retry-After", async () => {
    const { fetch, calls } = scriptedFetch(
      challenge(),
      new Response(null, { status: 409, headers: { "retry-after": "2" } }),
      paid(),
    );
    const error = await outcome(fetch);
    expect(error.kind).toBe("settlement-in-progress");
    expect(error.retryAfterMs).toBe(2000);
    expect(await error.resend?.()).toEqual(receipt);
    // One signature, sent twice, byte for byte.
    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);
    const sent = calls
      .slice(1)
      .map((call) => new Headers(call.init?.headers).get(PAYMENT_SIGNATURE_HEADER));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
  });

  it.each([
    ["no Retry-After", {}],
    ["a date Retry-After", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }],
    ["a negative Retry-After", { "retry-after": "-1" }],
  ])("treats a 409 with %s as ambiguous: the payment may have settled", async (_name, headers) => {
    const { fetch } = scriptedFetch(challenge(), new Response(null, { status: 409, headers }));
    const error = await outcome(fetch);
    expect(error.kind).toBe("ambiguous");
    expect(error.code).toBe("outcome-unknown");
    expect(error.resend).toBeUndefined();
  });

  it.each([500, 502, 504])("treats a %i after the signed request as ambiguous", async (status) => {
    const { fetch } = scriptedFetch(challenge(), new Response(null, { status }));
    expect((await outcome(fetch)).kind).toBe("ambiguous");
  });

  it("treats a dropped connection after the signed request as ambiguous", async () => {
    let call = 0;
    const fetch = (async () => {
      call += 1;
      if (call === 1) return challenge();
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const error = await outcome(fetch);
    expect(error.kind).toBe("ambiguous");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("treats any other 4xx as fatal", async () => {
    const { fetch } = scriptedFetch(challenge(), new Response(null, { status: 403 }));
    expect((await outcome(fetch)).kind).toBe("fatal");
  });

  it.each([
    ["amount", { amount: "20000" }],
    ["asset", { asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["payee", { payTo: Keypair.random().publicKey() }],
  ])("refuses to sign again when the retry's challenge changed the %s", async (_field, change) => {
    const { fetch } = scriptedFetch(challenge());
    const pinned = { amount: "10000", asset: USDC, payTo: PAYEE, ...change };
    const error = await outcome(fetch, { pinned });
    expect(error.kind).toBe("fatal");
    expect(error.message).toContain("changed between attempts");
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });
});

describe("createX402Settler offerChecks (#209)", () => {
  const OTHER = Keypair.random().publicKey();

  function checkedSettler(fetch: typeof globalThis.fetch, allowedPayees: string[]) {
    return createX402Settler({
      signer: createEd25519Signer(AGENT.secret(), "stellar:testnet"),
      network: "testnet",
      fetch,
      offerChecks: { allowedPayees },
    });
  }

  it("signs only the allowed option when a disallowed payee comes first", async () => {
    const disallowed: PaymentRequirements = { ...stellarExact, payTo: OTHER };
    const { fetch, calls } = scriptedFetch(
      challenge(paymentRequired([disallowed, stellarExact])),
      paid(),
    );

    await checkedSettler(fetch, [PAYEE]).settle({ resource: RESOURCE, offer, model: "x402" });

    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(scheme.createPaymentPayload).toHaveBeenCalledWith(2, stellarExact);
    const sent = (calls[1]?.init?.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER];
    expect(decodePaymentSignatureHeader(sent ?? "").accepted.payTo).toBe(PAYEE);
  });

  it("signs nothing when every option is outside the allowlist", async () => {
    const { fetch, calls } = scriptedFetch(challenge(paymentRequired([stellarExact])));

    await expect(
      checkedSettler(fetch, [OTHER]).settle({ resource: RESOURCE, offer, model: "x402" }),
    ).rejects.toThrow(/within the offer-check allowlists/);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("refuses a malformed configuration when the settler is created", () => {
    expect(() => checkedSettler(scriptedFetch().fetch, [""])).toThrow(TypeError);
  });
});
