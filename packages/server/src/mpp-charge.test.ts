import { StellarMppError } from "@stellar/mpp";
// A top-level type import, not typeof import(...) inside the generic below:
// Semgrep cannot parse the inline form, and the security check rejects files
// it cannot read.
import type * as ChargeServer from "@stellar/mpp/charge/server";
import { Store } from "@stellar/mpp/charge/server";
import {
  Account,
  Address,
  authorizeEntry,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  Ed25519Signer,
  type MppChargePayment,
  type PaymentOffer,
  TollwayError,
} from "@vegaforge/tollway-core";
import { Challenge, Credential, Errors } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall, type PaywallDeps } from "./gate.js";
import {
  createMockMppChargeHandler,
  createMppChargeHandler,
  deriveMppChargeNonce,
  type MppChargeOptions,
} from "./mpp-charge.js";
import { createInMemoryServicePolicyStore } from "./service-policy.js";

// The mppx server and the @stellar/mpp charge method are stubbed at the
// module boundary: nothing here reaches a network. Credentials and
// challenges are built with the real mppx encoders, so the handler's own
// decoding and HMAC check run for real.
const stub = vi.hoisted(() => ({
  mppx: { charge: vi.fn(), verifyCredential: vi.fn() },
  create: vi.fn(),
  stellarCharge: vi.fn(),
}));

vi.mock("@stellar/mpp/charge/server", async (importOriginal) => {
  const actual = await importOriginal<typeof ChargeServer>();
  return {
    ...actual,
    Mppx: { create: stub.create },
    stellar: { charge: stub.stellarCharge },
  };
});

const SECRET = "test-mpp-secret-key-that-must-never-leak";
const RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const PAYER_KEY = Keypair.random();
const PAYER = PAYER_KEY.publicKey();
const OTHER_KEY = Keypair.random();
/** The all-zeros placeholder source a sponsored (fee-payer) transaction uses. */
const SPONSORED_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TX_HASH = "a".repeat(64);

const offer: PaymentOffer = {
  resource: "/quotes/latest",
  amount: "10000",
  asset: USDC,
  payTo: RECIPIENT,
  network: "testnet",
  models: ["mpp-charge"],
};

function options(overrides: Partial<MppChargeOptions> = {}): MppChargeOptions {
  return {
    recipient: RECIPIENT,
    currency: USDC,
    network: "testnet",
    secretKey: SECRET,
    store: Store.memory(),
    ...overrides,
  };
}

function transferArgs(from: string): xdr.ScVal[] {
  return [
    new Address(from).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(BigInt(offer.amount), { type: "i128" }),
  ];
}

/**
 * A pull-mode transfer `from` pays, built the way an agent builds one. With
 * `signer` the envelope is signed (the payer is the transaction source); with
 * `auth` the transfer carries that Soroban authorization entry instead.
 */
function transferXdr(options: {
  from?: string;
  source?: string;
  signer?: Keypair;
  auth?: xdr.SorobanAuthorizationEntry;
}): string {
  const from = options.from ?? PAYER;
  const tx = new TransactionBuilder(new Account(options.source ?? from, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: USDC,
        function: "transfer",
        args: transferArgs(from),
        ...(options.auth ? { auth: [options.auth] } : {}),
      }),
    )
    .setTimeout(60)
    .build();
  if (options.signer) tx.sign(options.signer);
  return tx.toXDR();
}

/** A Soroban address authorization for `from`'s transfer, signed by `signer`. */
async function transferAuthorization(
  from: string,
  signer: Keypair,
): Promise<xdr.SorobanAuthorizationEntry> {
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(from).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(USDC).toScAddress(),
          functionName: "transfer",
          args: transferArgs(from),
        }),
      ),
      subInvocations: [],
    }),
  });
  return authorizeEntry(unsigned, signer, 1_000, Networks.TESTNET);
}

function credential(
  overrides: {
    secretKey?: string;
    amount?: string;
    method?: string;
    source?: string | null;
    payload?: (challengeId: string) => Record<string, unknown>;
  } = {},
): string {
  const challenge = Challenge.from({
    secretKey: overrides.secretKey ?? SECRET,
    realm: "tollway",
    method: overrides.method ?? "stellar",
    intent: "charge",
    request: {
      amount: overrides.amount ?? offer.amount,
      currency: USDC,
      recipient: RECIPIENT,
      methodDetails: { network: "stellar:testnet" },
    },
  });
  const source =
    overrides.source === null
      ? undefined
      : (overrides.source ?? `did:pkh:stellar:testnet:${PAYER}`);
  const payload = overrides.payload
    ? overrides.payload(challenge.id)
    : { type: "transaction", transaction: transferXdr({ signer: PAYER_KEY }) };
  return Credential.serialize({
    challenge,
    payload,
    ...(source ? { source } : {}),
  });
}

function payment(payload: string): MppChargePayment {
  return { model: "mpp-charge", payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.create.mockReturnValue(stub.mppx);
  stub.stellarCharge.mockImplementation((parameters: unknown) => ({ parameters }));
});

describe("createMppChargeHandler", () => {
  it("configures mppx and the stellar charge method from the options", () => {
    const store = Store.memory();
    const feePayer = { envelopeSigner: "SFEEPAYER" };
    createMppChargeHandler(options({ store, feePayer, rpcUrl: "https://rpc.example" }));

    expect(stub.stellarCharge).toHaveBeenCalledWith({
      recipient: RECIPIENT,
      currency: USDC,
      network: "stellar:testnet",
      decimals: 0,
      store,
      feePayer,
      rpcUrl: "https://rpc.example",
    });
    expect(stub.create).toHaveBeenCalledWith({
      secretKey: SECRET,
      realm: "tollway",
      methods: [{ parameters: expect.objectContaining({ recipient: RECIPIENT }) }],
    });
  });

  it("maps mainnet to the stellar:pubnet network id", () => {
    createMppChargeHandler(options({ network: "mainnet" }));
    expect(stub.stellarCharge).toHaveBeenCalledWith(
      expect.objectContaining({ network: "stellar:pubnet" }),
    );
  });

  it("fails fast without a secret key or an atomic store", () => {
    expect(() => createMppChargeHandler(options({ secretKey: "" }))).toThrow(/secretKey/);
    expect(() =>
      createMppChargeHandler(options({ store: {} as unknown as MppChargeOptions["store"] })),
    ).toThrow(/atomic mppx store/);
  });

  describe("challenge", () => {
    it("returns the 402 that mppx produces, scoped to the offer's resource", async () => {
      const respond = vi.fn(async (_request: Request) => ({
        status: 402,
        challenge: new Response(null, {
          status: 402,
          headers: { "WWW-Authenticate": 'Payment id="abc"', "Cache-Control": "no-store" },
        }),
      }));
      stub.mppx.charge.mockReturnValue(respond);
      const handler = createMppChargeHandler(options());

      const result = await handler.challenge?.({
        offer,
        request: { method: "GET", url: "/quotes/latest" },
      });

      expect(stub.mppx.charge).toHaveBeenCalledWith({ amount: "10000", scope: "/quotes/latest" });
      const request = respond.mock.calls[0]?.[0];
      expect(request?.method).toBe("GET");
      expect(request?.url).toBe("https://tollway/quotes/latest");
      expect(request?.headers.get("authorization")).toBeNull();
      expect(result).toEqual({
        status: 402,
        headers: { "www-authenticate": 'Payment id="abc"', "cache-control": "no-store" },
        body: null,
      });
    });

    it("refuses an offer that does not match the handler's recipient", async () => {
      const handler = createMppChargeHandler(options());
      await expect(
        handler.challenge?.({
          offer: { ...offer, payTo: PAYER },
          request: { method: "GET", url: "/quotes/latest" },
        }),
      ).rejects.toThrow(TollwayError);
    });
  });

  describe("verify", () => {
    it("accepts a credential this server issued and reads the payer and nonce", async () => {
      const handler = createMppChargeHandler(options());
      const payload = credential();

      const result = await handler.verify({ payment: payment(payload), offer });

      expect(result).toEqual({
        valid: true,
        payer: PAYER,
        nonce: await deriveMppChargeNonce(payload),
      });
      expect(stub.mppx.verifyCredential).not.toHaveBeenCalled();
    });

    it("accepts a sponsored transfer the source authorized with a Soroban auth entry", async () => {
      const handler = createMppChargeHandler(options());
      const auth = await transferAuthorization(PAYER, PAYER_KEY);
      const payload = credential({
        payload: () => ({
          type: "transaction",
          transaction: transferXdr({ source: SPONSORED_SOURCE, auth }),
        }),
      });

      const result = await handler.verify({ payment: payment(payload), offer });
      expect(result).toMatchObject({ valid: true, payer: PAYER });
    });

    it("rejects a sponsored transfer whose auth entry another key signed", async () => {
      const handler = createMppChargeHandler(options());
      const auth = await transferAuthorization(PAYER, OTHER_KEY);
      const payload = credential({
        payload: () => ({
          type: "transaction",
          transaction: transferXdr({ source: SPONSORED_SOURCE, auth }),
        }),
      });

      const result = await handler.verify({ payment: payment(payload), offer });
      expect(result).toEqual({ valid: false, reason: expect.stringMatching(/did not sign/) });
    });

    it("accepts a push-mode hash the source signed with the challenge id", async () => {
      const handler = createMppChargeHandler(options());
      const payload = credential({
        payload: (challengeId) => ({
          type: "signedHash",
          hash: TX_HASH,
          sourceSignature: PAYER_KEY.sign(Buffer.from(`${challengeId}:${TX_HASH}`)).toString("hex"),
        }),
      });

      const result = await handler.verify({ payment: payment(payload), offer });
      expect(result).toMatchObject({ valid: true, payer: PAYER });
    });

    it.each([
      ["a malformed credential", () => "Payment not-base64-json", /malformed mpp credential/],
      [
        "a challenge another server issued",
        () => credential({ secretKey: "someone-else" }),
        /not issued by this server/,
      ],
      ["a different amount", () => credential({ amount: "1" }), /amount does not match/],
      ["another payment method", () => credential({ method: "tempo" }), /not stellar\/charge/],
      ["a missing source", () => credential({ source: null }), /source is not a Stellar account/],
      [
        "a source on another network",
        () => credential({ source: `did:pkh:stellar:pubnet:${PAYER}` }),
        /source is not a Stellar account/,
      ],
      [
        "a transfer signed by someone other than the source",
        () =>
          credential({
            payload: () => ({
              type: "transaction",
              transaction: transferXdr({ signer: OTHER_KEY }),
            }),
          }),
        /source did not sign this payment/,
      ],
      [
        "an unsigned transfer from the source",
        () =>
          credential({ payload: () => ({ type: "transaction", transaction: transferXdr({}) }) }),
        /source did not sign this payment/,
      ],
      [
        "a transfer from another account than the source",
        () =>
          credential({
            payload: () => ({
              type: "transaction",
              transaction: transferXdr({ from: OTHER_KEY.publicKey(), signer: OTHER_KEY }),
            }),
          }),
        /transfer is not from the credential source/,
      ],
      [
        "a transaction that is not a Stellar transaction",
        () => credential({ payload: () => ({ type: "transaction", transaction: "AAAA" }) }),
        /not a valid Stellar transaction/,
      ],
      [
        "an unsigned push-mode hash",
        () => credential({ payload: () => ({ type: "hash", hash: TX_HASH }) }),
        /does not prove its source/,
      ],
      [
        "a push-mode hash signed by someone other than the source",
        () =>
          credential({
            payload: (challengeId) => ({
              type: "signedHash",
              hash: TX_HASH,
              sourceSignature: OTHER_KEY.sign(Buffer.from(`${challengeId}:${TX_HASH}`)).toString(
                "hex",
              ),
            }),
          }),
        /source did not sign this payment/,
      ],
    ])("rejects %s", async (_name, build, reason) => {
      const handler = createMppChargeHandler(options());
      const result = await handler.verify({ payment: payment(build()), offer });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.reason).toMatch(reason);
      expect(result.reason).not.toContain(SECRET);
    });

    it("rejects an offer whose asset is not the handler's currency", async () => {
      const handler = createMppChargeHandler(options());
      const result = await handler.verify({
        payment: payment(credential()),
        offer: { ...offer, asset: "USDC:GA5Z" },
      });
      expect(result).toEqual({
        valid: false,
        reason: "mpp charge handler currency does not match the offer asset",
      });
    });
  });

  describe("settle", () => {
    it("verifies against the offer and returns the on-chain transaction hash", async () => {
      stub.mppx.verifyCredential.mockResolvedValue({
        method: "stellar",
        reference: TX_HASH,
        status: "success",
        timestamp: "2026-11-19T00:00:00Z",
      });
      const handler = createMppChargeHandler(options());
      const payload = credential();

      const result = await handler.settle({
        payment: payment(payload),
        offer,
        payer: PAYER,
        nonce: "n",
      });

      expect(result).toEqual({ settled: true, txHash: TX_HASH });
      expect(stub.mppx.verifyCredential).toHaveBeenCalledWith(payload, {
        request: { amount: "10000" },
        scope: "/quotes/latest",
      });
    });

    it("maps an mppx payment error to a rejection", async () => {
      stub.mppx.verifyCredential.mockRejectedValue(
        new Errors.VerificationFailedError({ reason: "transfer amount mismatch" }),
      );
      const handler = createMppChargeHandler(options());
      const result = await handler.settle({
        payment: payment(credential()),
        offer,
        payer: PAYER,
        nonce: "n",
      });
      expect(result.settled).toBe(false);
      if (result.settled) return;
      expect(result.reason).toMatch(/^mpp charge rejected: /);
      expect(result.reason).toContain("transfer amount mismatch");
    });

    it("maps a @stellar/mpp error to a rejection", async () => {
      stub.mppx.verifyCredential.mockRejectedValue(
        new StellarMppError("[stellar:charge] Transaction failed on chain."),
      );
      const handler = createMppChargeHandler(options());
      const result = await handler.settle({
        payment: payment(credential()),
        offer,
        payer: PAYER,
        nonce: "n",
      });
      expect(result).toEqual({
        settled: false,
        reason: "mpp charge rejected: [stellar:charge] Transaction failed on chain.",
      });
    });

    it("turns a transport failure into a payment-failed TollwayError", async () => {
      stub.mppx.verifyCredential.mockRejectedValue(new TypeError("fetch failed"));
      const handler = createMppChargeHandler(options());
      const settling = handler.settle({
        payment: payment(credential()),
        offer,
        payer: PAYER,
        nonce: "n",
      });
      await expect(settling).rejects.toBeInstanceOf(TollwayError);
      await expect(settling).rejects.toMatchObject({
        code: "payment-failed",
        message: "mpp charge settlement failed: fetch failed",
      });
    });
  });

  describe("settle error classification", () => {
    async function settleWith(error: unknown) {
      stub.mppx.verifyCredential.mockRejectedValue(error);
      const handler = createMppChargeHandler(options());
      return handler.settle({ payment: payment(credential()), offer, payer: PAYER, nonce: "n" });
    }

    it("rejects, rather than throws, on an SDK error from a malformed transaction", async () => {
      await expect(
        settleWith(new Error("XDR Read Error: attempt to read outside the boundary of the buffer")),
      ).resolves.toEqual({
        settled: false,
        reason:
          "mpp charge rejected: invalid payment: XDR Read Error: attempt to read outside the boundary of the buffer",
      });
    });

    it.each([
      ["an axios error", Object.assign(new Error("socket hang up"), { isAxiosError: true })],
      ["an abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
      ["a refused connection", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ])("throws payment-failed on %s", async (_name, error) => {
      await expect(settleWith(error)).rejects.toMatchObject({ code: "payment-failed" });
    });
  });

  describe("through the gate", () => {
    async function gate(deps: Partial<PaywallDeps> = {}) {
      return createPaywall(
        {
          amount: offer.amount,
          asset: USDC,
          payTo: RECIPIENT,
          network: "testnet",
          models: ["mpp-charge"],
        },
        {
          signer: await Ed25519Signer.generate("mpp-gate-test"),
          facilitator: createMockFacilitator(),
          mppChargeHandler: createMppChargeHandler(options()),
          cache: createInMemorySettlementCache(),
          ...deps,
        },
      );
    }

    it("refuses a credential that names an allowed payer it cannot sign for, before policy", async () => {
      stub.mppx.verifyCredential.mockResolvedValue({ reference: TX_HASH });
      const store = createInMemoryServicePolicyStore();
      const admit = vi.spyOn(store, "admit");
      const paywall = await gate({
        servicePolicy: { allowPayers: [PAYER] },
        servicePolicyStore: store,
      });
      const forged = credential({
        payload: () => ({ type: "transaction", transaction: transferXdr({ signer: OTHER_KEY }) }),
      });

      const outcome = await paywall({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: forged },
      });

      expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
      expect(admit).not.toHaveBeenCalled();
      expect(stub.mppx.verifyCredential).not.toHaveBeenCalled();
    });

    it("settles once and produces an mpp-charge receipt with the tx hash", async () => {
      stub.mppx.verifyCredential.mockResolvedValue({ reference: TX_HASH });
      const outcome = await (await gate())({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: credential() },
      });
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.receipt.receipt.model).toBe("mpp-charge");
      expect(outcome.receipt.receipt.payer).toBe(PAYER);
      expect(outcome.receipt.receipt.settlement).toEqual({
        kind: "transaction",
        txHash: TX_HASH,
      });
    });

    it("dedupes a retried credential: one settlement, the same receipt", async () => {
      stub.mppx.verifyCredential.mockResolvedValue({ reference: TX_HASH });
      const paywall = await gate();
      const request = {
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: credential() },
      };

      const [first, concurrent] = await Promise.all([paywall(request), paywall(request)]);
      const retry = await paywall(request);

      expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
      for (const outcome of [first, concurrent, retry]) {
        expect(outcome.kind).toBe("settled");
      }
      if (first.kind !== "settled" || retry.kind !== "settled") return;
      expect(retry.replayed).toBe(true);
      expect(retry.receipt.receipt.id).toBe(first.receipt.receipt.id);
    });

    it("answers a failed settlement with a 502 rejection and caches nothing", async () => {
      stub.mppx.verifyCredential
        .mockRejectedValueOnce(new StellarMppError("[stellar:charge] simulation failed"))
        .mockResolvedValueOnce({ reference: TX_HASH });
      const paywall = await gate();
      const request = {
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: credential() },
      };

      const failed = await paywall(request);
      expect(failed).toEqual({
        kind: "rejected",
        status: 502,
        reason: "mpp charge rejected: [stellar:charge] simulation failed",
      });
      const retried = await paywall(request);
      expect(retried.kind).toBe("settled");
      expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(2);
    });
  });
});

const mockOffer: PaymentOffer = {
  resource: "https://api.example.com/quotes/latest",
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  models: ["mpp-charge"],
};

const mockPayment: MppChargePayment = { model: "mpp-charge", payload: "AAAA-mpp-charge-payload" };

describe("createMockMppChargeHandler", () => {
  it("verifies a non-empty mpp charge payload", async () => {
    const handler = createMockMppChargeHandler();
    const result = await handler.verify({ payment: mockPayment, offer: mockOffer });
    expect(result).toEqual({
      valid: true,
      payer: expect.any(String),
      nonce: expect.any(String),
    });
  });

  it("rejects an empty mpp charge payload", async () => {
    const handler = createMockMppChargeHandler();
    const result = await handler.verify({
      payment: { model: "mpp-charge", payload: "" },
      offer: mockOffer,
    });
    expect(result).toEqual({ valid: false, reason: "empty mpp charge payload" });
  });

  it("settles a verified payment and returns a tx hash", async () => {
    const handler = createMockMppChargeHandler();
    const verification = await handler.verify({ payment: mockPayment, offer: mockOffer });
    if (!verification.valid) throw new Error("expected verification to be valid");

    const result = await handler.settle({
      payment: mockPayment,
      offer: mockOffer,
      payer: verification.payer,
      nonce: verification.nonce,
    });
    expect(result).toEqual({
      settled: true,
      txHash: expect.any(String),
    });
  });

  it("derives a stable nonce from the same payload", async () => {
    const handler = createMockMppChargeHandler();
    const first = await handler.verify({ payment: mockPayment, offer: mockOffer });
    const second = await handler.verify({ payment: mockPayment, offer: mockOffer });
    if (!first.valid || !second.valid) throw new Error("expected both verifications to be valid");
    expect(first.nonce).toBe(second.nonce);
  });
});
