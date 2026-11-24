import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createPaywall,
  type GateOutcome,
  type PaywallConfig,
  type TollwayRequest,
} from "./gate.js";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_QUOTE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./headers.js";
import { createMockMppChargeHandler, type MppChargeHandler } from "./mpp-charge.js";

const MPP_CREDENTIAL = "Payment mock-mpp-charge-payload";

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

const baseRequest: TollwayRequest = {
  method: "GET",
  url: "/quotes/latest",
  headers: {},
};

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(transaction = "mock-signed-auth-entry"): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  });
}

/**
 * Pays a 402 the way a stock x402 V2 client does: it copies the challenge's
 * first `accepts` entry, `extra` included, into `accepted` and signs that.
 */
function payChallenge(
  challenge: Extract<GateOutcome, { kind: "payment-required" }>,
  transaction = "mock-signed-auth-entry",
  edit: (accepted: PaymentRequirements) => PaymentRequirements = (accepted) => accepted,
): string {
  const required = decodePaymentRequiredHeader(challenge.headers[PAYMENT_REQUIRED_HEADER] ?? "");
  const accepted = required.accepts[0];
  if (!accepted) throw new Error("the challenge offers no payment requirements");
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: edit(accepted),
    payload: { transaction },
  });
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
});

function makeGate(mppCharge = false) {
  return createPaywall(
    { ...config, models: mppCharge ? ["mpp-charge"] : ["x402"] },
    {
      signer,
      facilitator: createMockFacilitator(),
      mppChargeHandler: mppCharge ? createMockMppChargeHandler() : undefined,
      cache: createInMemorySettlementCache(),
    },
  );
}

describe("createPaywall", () => {
  it("answers 402 with an x402 V2 challenge when no payment is present", async () => {
    const outcome = await makeGate()(baseRequest);
    expect(outcome.kind).toBe("payment-required");
    if (outcome.kind !== "payment-required") return;

    expect(outcome.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "");
    expect(decoded).toEqual(outcome.challenge);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("/quotes/latest");
    expect(decoded.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: "stellar:testnet",
        asset: config.asset,
        amount: "10000",
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      }),
    ]);
  });

  it("sends the x402 challenge terms the paywall config declares", async () => {
    const gate = createPaywall(
      { ...config, maxTimeoutSeconds: 30, extra: { areFeesSponsored: true } },
      { signer, facilitator: createMockFacilitator() },
    );
    const outcome = await gate(baseRequest);
    if (outcome.kind !== "payment-required") throw new Error("expected a challenge");
    expect(
      decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "").accepts[0],
    ).toMatchObject({ maxTimeoutSeconds: 30, extra: { areFeesSponsored: true } });
  });

  it("rejects a malformed PAYMENT-SIGNATURE with 400", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "%%%not-base64%%%" },
    });
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toMatch(/not a base64 x402 PaymentPayload/);
  });

  it("rejects a base64url PAYMENT-SIGNATURE with 400", async () => {
    // U+0080 U+00BE encode to bytes that standard base64 spells with `+`, so
    // the base64url form contains `-` and cannot pass @x402/core's
    // standard-alphabet check.
    const standard = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "stellar:testnet",
        asset: config.asset,
        amount: config.amount,
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { transaction: "mock-signed-auth-entry" },
      extensions: { probe: "\u0080\u00be" },
    });
    const base64url = Buffer.from(standard, "base64").toString("base64url");
    expect(base64url).not.toBe(standard);
    expect(() => decodePaymentSignatureHeader(base64url)).toThrow();
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: base64url },
    });
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
  });

  it("rejects a payment whose x402Version is not 2 with 400", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 1,
          accepted: {
            scheme: "exact",
            network: "stellar:testnet",
            asset: config.asset,
            amount: config.amount,
            payTo: config.payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: { transaction: "mock-signed-auth-entry" },
        }),
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      status: 400,
      reason: expect.stringContaining("unsupported x402Version 1"),
    });
  });

  it("sends the x402 SettleResponse and the Tollway receipt on settlement", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
    });
    if (outcome.kind !== "settled") throw new Error("expected a settlement");

    const settlement = decodePaymentResponseHeader(outcome.headers[PAYMENT_RESPONSE_HEADER] ?? "");
    expect(settlement).toMatchObject({ success: true, network: "stellar:testnet" });
    const { settlement: settled } = outcome.receipt.receipt;
    if (settled.kind !== "transaction") throw new Error("expected a transaction settlement");
    expect(settlement.transaction).toBe(settled.txHash);
    expect(decodeHeader(outcome.headers[TOLLWAY_RECEIPT_HEADER] ?? "")).toEqual(outcome.receipt);
  });

  it("settles a signed request and produces a verifiable receipt", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;

    expect(outcome.replayed).toBe(false);
    expect(outcome.receipt.receipt.model).toBe("x402");
    expect(outcome.receipt.receipt.amount).toBe("10000");
    expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

    const verifier = Ed25519Verifier.forSigner(signer);
    expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({
      valid: true,
      receipt: outcome.receipt,
    });
  });

  it("treats a repeated payment as idempotent rather than a second charge", async () => {
    const gate = makeGate();
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

    const first = await gate({ ...baseRequest, headers });
    const second = await gate({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.receipt.receipt.id).toBe(first.receipt.receipt.id);
  });

  // #284: on chain, a settled payment's auth nonce is spent, so verifying the
  // same payment again fails. A retry must find the cached receipt first.
  it("replays a settled payment without verifying it again", async () => {
    const mock = createMockFacilitator();
    const spent = new Set<string>();
    const verify = vi.fn(mock.verify);
    const chainLike: FacilitatorClient = {
      ...mock,
      async verify(input) {
        const result = await verify(input);
        if (result.valid && spent.has(result.nonce)) {
          return { valid: false, reason: "nonce already exists for address" };
        }
        return result;
      },
      async settle(input) {
        const result = await mock.settle(input);
        if (result.settled) spent.add(input.nonce);
        return result;
      },
    };
    const gate = createPaywall(
      { ...config, models: ["x402"] },
      { signer, facilitator: chainLike, cache: createInMemorySettlementCache() },
    );
    const request = {
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("retried-transaction") },
    };

    const first = await gate(request);
    const retry = await gate(request);

    expect(first.kind).toBe("settled");
    expect(retry.kind).toBe("settled");
    if (first.kind !== "settled" || retry.kind !== "settled") return;
    expect(retry.replayed).toBe(true);
    expect(retry.receipt).toEqual(first.receipt);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("refuses to settle when verify disagrees with the idempotency key", async () => {
    const mock = createMockFacilitator();
    const settle = vi.fn(mock.settle);
    const gate = createPaywall(
      { ...config, models: ["x402"] },
      {
        signer,
        facilitator: { ...mock, settle, idempotencyKey: async () => "a-different-nonce" },
        cache: createInMemorySettlementCache(),
      },
    );
    const outcome = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mismatched-transaction") },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.status).toBe(500);
    expect(settle).not.toHaveBeenCalled();
  });

  it("treats an empty signature header as no payment at all", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "" },
    });
    expect(outcome.kind).toBe("payment-required");
  });

  it("binds a dynamic quote to the verified and receipted amount", async () => {
    let calls = 0;
    const seenAmounts: string[] = [];
    const facilitator: FacilitatorClient = {
      async verify({ offer }) {
        seenAmounts.push(offer.amount);
        return { valid: true, payer: "GPAYER", nonce: "NONCE-DYNAMIC" };
      },
      async settle({ offer }) {
        seenAmounts.push(offer.amount);
        return { settled: true, txHash: "a".repeat(64) };
      },
      async supported() {
        return {
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:*" }],
          extensions: [],
          signers: {},
        };
      },
    };
    const gate = createPaywall(
      {
        ...config,
        amount: () => {
          calls += 1;
          return String(100 + calls);
        },
        minAmount: "100",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
      },
      { signer, facilitator },
    );
    const challenge = await gate(baseRequest);
    expect(challenge.kind).toBe("payment-required");
    if (challenge.kind !== "payment-required") return;
    const quote = challenge.headers[TOLLWAY_QUOTE_HEADER];
    expect(quote).toBeTruthy();
    expect(challenge.challenge.accepts[0]?.extra.tollwayQuote).toBe(quote);
    expect(challenge.challenge.accepts[0]?.amount).toBe("101");

    // The quote comes back inside the signed payload; no extra header.
    const paid = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(challenge) },
    });
    expect(paid.kind).toBe("settled");
    if (paid.kind !== "settled") return;
    expect(calls).toBe(1);
    expect(seenAmounts).toEqual(["101", "101"]);
    expect(paid.receipt.receipt.amount).toBe("101");
  });

  it("rejects a tampered dynamic quote with a fresh challenge", async () => {
    const price = vi.fn().mockReturnValue("100");
    const gate = createPaywall(
      {
        ...config,
        amount: price,
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
      },
      { signer, facilitator: createMockFacilitator() },
    );
    const first = await gate(baseRequest);
    if (first.kind !== "payment-required") throw new Error("expected challenge");
    const quote = String(first.challenge.accepts[0]?.extra.tollwayQuote ?? "");
    const tampered = `${quote.slice(0, -1)}${quote.endsWith("A") ? "B" : "A"}`;
    const second = await gate({
      ...baseRequest,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: payChallenge(first, "mock-signed-auth-entry", (accepted) => ({
          ...accepted,
          extra: { ...accepted.extra, tollwayQuote: tampered },
        })),
      },
    });
    expect(second.kind).toBe("payment-required");
    expect(price).toHaveBeenCalledTimes(2);
  });

  describe("a price function that misbehaves", () => {
    const cases: { name: string; price: () => unknown }[] = [
      {
        name: "throws",
        price: () => {
          throw new Error("pricing backend down");
        },
      },
      { name: "returns more than maxAmount", price: () => "201" },
      { name: "returns less than minAmount", price: () => "0" },
      { name: "returns a negative amount", price: () => "-5" },
      { name: "returns a decimal amount", price: () => "1.5" },
      { name: "returns a number, not a string", price: () => 100 },
    ];
    for (const { name, price } of cases) {
      it(`rejects the request, never charges, when it ${name}`, async () => {
        const mock = createMockFacilitator();
        const settle = vi.fn(mock.settle);
        const gate = createPaywall(
          {
            ...config,
            amount: price as () => string,
            minAmount: "1",
            maxAmount: "200",
            quoteSecret: "a sufficiently long quote secret",
          },
          { signer, facilitator: { ...mock, settle } },
        );
        const challenge = await gate(baseRequest);
        expect(challenge).toMatchObject({ kind: "rejected", status: 500 });
        if (challenge.kind !== "rejected") return;
        expect(challenge.reason).toMatch(/^invalid-amount: dynamic price/);

        const paid = await gate({
          ...baseRequest,
          headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("misbehaving-price") },
        });
        expect(paid).toMatchObject({ kind: "rejected", status: 500 });
        expect(settle).not.toHaveBeenCalled();
      });
    }
  });

  it("hands a price function's error to onPriceError, not to the agent", async () => {
    const failure = new Error("pricing backend down: db password rejected");
    const onPriceError = vi.fn();
    const gate = createPaywall(
      {
        ...config,
        amount: () => {
          throw failure;
        },
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
      },
      { signer, facilitator: createMockFacilitator(), onPriceError },
    );
    const outcome = await gate(baseRequest);
    expect(onPriceError).toHaveBeenCalledWith(failure, baseRequest);
    expect(outcome).toMatchObject({ kind: "rejected", status: 500 });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).not.toContain("password");
  });

  it("replays a settled payment retried after its quote expired", async () => {
    let now = 1_000_000;
    const mock = createMockFacilitator();
    const settle = vi.fn(mock.settle);
    const gate = createPaywall(
      {
        ...config,
        amount: () => "120",
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
        quoteTtlSeconds: 30,
      },
      {
        signer,
        facilitator: { ...mock, settle },
        cache: createInMemorySettlementCache(),
        clock: () => now,
      },
    );
    const challenge = await gate(baseRequest);
    if (challenge.kind !== "payment-required") throw new Error("expected challenge");
    const request = {
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(challenge, "settled-then-expired") },
    };
    const paid = await gate(request);
    expect(paid).toMatchObject({ kind: "settled", replayed: false });

    // A 402 here would make a stock client pay a second time.
    now += 31_000;
    const retry = await gate(request);
    expect(retry).toMatchObject({ kind: "settled", replayed: true });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  describe("quote secret rotation", () => {
    const priced = {
      ...config,
      amount: () => "100",
      minAmount: "1",
      maxAmount: "200",
    };

    async function quoteSignedWith(quoteSecret: string) {
      const gate = createPaywall(
        { ...priced, quoteSecret },
        { signer, facilitator: createMockFacilitator() },
      );
      const challenge = await gate(baseRequest);
      if (challenge.kind !== "payment-required") throw new Error("expected challenge");
      return challenge;
    }

    it("accepts a quote signed with a previous secret", async () => {
      const challenge = await quoteSignedWith("the old quote secret");
      const gate = createPaywall(
        {
          ...priced,
          quoteSecret: "the new quote secret",
          previousQuoteSecrets: ["the old quote secret"],
        },
        { signer, facilitator: createMockFacilitator() },
      );
      const outcome = await gate({
        ...baseRequest,
        headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(challenge, "rotated") },
      });
      expect(outcome).toMatchObject({ kind: "settled" });
    });

    it("refuses a quote whose secret was dropped", async () => {
      const challenge = await quoteSignedWith("the old quote secret");
      const gate = createPaywall(
        { ...priced, quoteSecret: "the new quote secret" },
        { signer, facilitator: createMockFacilitator() },
      );
      const outcome = await gate({
        ...baseRequest,
        headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(challenge, "dropped") },
      });
      expect(outcome.kind).toBe("payment-required");
    });

    it("rejects an empty previous secret at construction", () => {
      expect(() =>
        createPaywall(
          { ...priced, quoteSecret: "the new quote secret", previousQuoteSecrets: [""] },
          { signer, facilitator: createMockFacilitator() },
        ),
      ).toThrow(/previousQuoteSecrets/);
    });
  });

  it("does not let a payment settled under one quote unlock a new price", async () => {
    let current = "101";
    const mock = createMockFacilitator();
    const settle = vi.fn(mock.settle);
    const gate = createPaywall(
      {
        ...config,
        amount: () => current,
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
      },
      { signer, facilitator: { ...mock, settle }, cache: createInMemorySettlementCache() },
    );
    const first = await gate(baseRequest);
    if (first.kind !== "payment-required") throw new Error("expected challenge");
    const paid = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(first, "quoted-transaction") },
    });
    expect(paid).toMatchObject({ kind: "settled", replayed: false });

    // The price moves. A fresh, valid quote at the new price, wrapped around
    // the transaction that already settled at the old one, must not replay
    // the old receipt.
    current = "150";
    const second = await gate(baseRequest);
    if (second.kind !== "payment-required") throw new Error("expected challenge");
    const replay = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(second, "quoted-transaction") },
    });
    expect(replay).toMatchObject({ kind: "rejected", status: 409 });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not let a quote for one resource pay for another", async () => {
    const price = vi.fn().mockReturnValue("100");
    const gate = createPaywall(
      {
        ...config,
        amount: price,
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
      },
      { signer, facilitator: createMockFacilitator() },
    );
    const cheap = await gate({ ...baseRequest, url: "/quotes/cheap" });
    if (cheap.kind !== "payment-required") throw new Error("expected challenge");
    const outcome = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(cheap) },
    });
    expect(outcome.kind).toBe("payment-required");
    expect(price).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired dynamic quote with a fresh challenge", async () => {
    let now = 1_000_000;
    const price = vi.fn().mockReturnValue("100");
    const gate = createPaywall(
      {
        ...config,
        amount: price,
        minAmount: "1",
        maxAmount: "200",
        quoteSecret: "a sufficiently long quote secret",
        quoteTtlSeconds: 30,
      },
      { signer, facilitator: createMockFacilitator(), clock: () => now },
    );
    const first = await gate(baseRequest);
    if (first.kind !== "payment-required") throw new Error("expected challenge");
    now += 31_000;
    const outcome = await gate({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: payChallenge(first) },
    });
    expect(outcome.kind).toBe("payment-required");
    expect(price).toHaveBeenCalledTimes(2);
  });

  describe("with mpp-charge model", () => {
    it("settles a signed request and produces a verifiable receipt", async () => {
      const outcome = await makeGate(true)({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;

      expect(outcome.replayed).toBe(false);
      expect(outcome.receipt.receipt.model).toBe("mpp-charge");
      expect(outcome.receipt.receipt.amount).toBe("10000");
      expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

      const verifier = Ed25519Verifier.forSigner(signer);
      expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({
        valid: true,
        receipt: outcome.receipt,
      });
    });

    it("treats a repeated mpp-charge payment as idempotent rather than a second charge", async () => {
      const gate = makeGate(true);
      const headers = { authorization: MPP_CREDENTIAL };

      const first = await gate({ ...baseRequest, headers });
      const second = await gate({ ...baseRequest, headers });
      expect(first.kind).toBe("settled");
      expect(second.kind).toBe("settled");
      if (first.kind !== "settled" || second.kind !== "settled") return;

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.receipt.receipt.id).toBe(first.receipt.receipt.id);
    });

    it("rejects when mpp-charge handler is not configured", async () => {
      const gate = createPaywall(
        { ...config, models: ["mpp-charge"] },
        {
          signer,
          facilitator: createMockFacilitator(),
          cache: createInMemorySettlementCache(),
        },
      );
      const outcome = await gate({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") return;
      expect(outcome.status).toBe(500);
      expect(outcome.reason).toBe("mpp-charge handler not configured");
    });

    it("passes only the Payment scheme of the Authorization header to the handler", async () => {
      const handler = createMockMppChargeHandler();
      const verify = vi.spyOn(handler, "verify");
      const gate = createPaywall(
        { ...config, models: ["mpp-charge"] },
        { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
      );
      await gate({ ...baseRequest, headers: { Authorization: `Bearer abc, ${MPP_CREDENTIAL}` } });
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ payment: { model: "mpp-charge", payload: MPP_CREDENTIAL } }),
      );
    });

    it("adds the handler's MPP challenge headers to the 402", async () => {
      const handler: MppChargeHandler = {
        ...createMockMppChargeHandler(),
        challenge: vi.fn().mockResolvedValue({
          status: 402,
          headers: {
            "www-authenticate": 'Payment id="abc"',
            "cache-control": "no-store",
            "content-type": "application/problem+json",
          },
          body: '{"title":"Payment Required"}',
        }),
      };
      const gate = createPaywall(
        { ...config, models: ["x402", "mpp-charge"] },
        { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
      );
      const outcome = await gate(baseRequest);
      expect(outcome.kind).toBe("payment-required");
      if (outcome.kind !== "payment-required") return;
      expect(outcome.headers["www-authenticate"]).toBe('Payment id="abc"');
      expect(outcome.headers["cache-control"]).toBe("no-store");
      // The adapters send the offer as JSON, so mppx's body headers are dropped.
      expect(outcome.headers["content-type"]).toBeUndefined();
      expect(outcome.headers[PAYMENT_REQUIRED_HEADER]).toBeDefined();
      expect(handler.challenge).toHaveBeenCalledWith({
        offer: expect.objectContaining({
          resource: "/quotes/latest",
          amount: "10000",
          asset: config.asset,
        }),
        request: { method: "GET", url: "/quotes/latest" },
      });
    });

    it("does not ask for an MPP challenge on a route that does not accept mpp-charge", async () => {
      const challenge = vi.fn();
      const gate = createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        mppChargeHandler: { ...createMockMppChargeHandler(), challenge },
      });
      const outcome = await gate(baseRequest);
      expect(outcome.kind).toBe("payment-required");
      expect(challenge).not.toHaveBeenCalled();
    });

    it("ignores an MPP credential on a route that only accepts x402", async () => {
      const outcome = await makeGate(false)({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("payment-required");
    });

    it("rejects a PAYMENT-SIGNATURE that the router sends to mpp-charge", async () => {
      const outcome = await makeGate(true)({
        ...baseRequest,
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      });
      expect(outcome).toEqual({
        kind: "rejected",
        status: 400,
        reason:
          "mpp-charge payments carry an Authorization: Payment credential, not PAYMENT-SIGNATURE",
      });
    });
  });
});

describe("TM-02 cross-offer replay", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

  function gateFor(overrides: Partial<PaywallConfig>, cache: SettlementCache) {
    return createPaywall(
      { ...config, ...overrides },
      {
        signer,
        facilitator: createMockFacilitator(),
        mppChargeHandler: createMockMppChargeHandler(),
        cache,
      },
    );
  }

  it("rejects a payment settled for one resource when replayed on another", async () => {
    const cache = createInMemorySettlementCache();
    const first = await gateFor({ resource: "/a" }, cache)({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");

    const replay = await gateFor({ resource: "/b" }, cache)({ ...baseRequest, headers });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });

  it("rejects a replay on an offer with a different amount", async () => {
    const cache = createInMemorySettlementCache();
    const first = await gateFor({ resource: "/a" }, cache)({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");

    const replay = await gateFor(
      { resource: "/a", amount: "99999999" },
      cache,
    )({
      ...baseRequest,
      headers,
    });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });

  it("does not serve an x402 receipt to an mpp-charge offer that shares the cache", async () => {
    const cache = createInMemorySettlementCache();
    const x402 = await gateFor(
      { models: ["x402"] },
      cache,
    )({ ...baseRequest, headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() } });
    expect(x402.kind).toBe("settled");

    const mpp = await gateFor(
      { models: ["mpp-charge"] },
      cache,
    )({ ...baseRequest, headers: { authorization: MPP_CREDENTIAL } });
    expect(mpp.kind).toBe("settled");
    if (mpp.kind !== "settled") return;
    expect(mpp.replayed).toBe(false);
    expect(mpp.receipt.receipt.model).toBe("mpp-charge");
  });

  describe("TM-03 same-process concurrent duplicate", () => {
    it("settles concurrent identical payments once", async () => {
      const inner = createMockFacilitator();
      let settleCalls = 0;
      const slowFacilitator: FacilitatorClient = {
        ...inner,
        async settle(input) {
          settleCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return inner.settle(input);
        },
      };
      const gate = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createInMemorySettlementCache(),
      });

      const [first, second] = await Promise.all([
        gate({ ...baseRequest, headers }),
        gate({ ...baseRequest, headers }),
      ]);

      expect(settleCalls).toBe(1);
      expect(first.kind).toBe("settled");
      expect(second.kind).toBe("settled");
      if (first.kind !== "settled" || second.kind !== "settled") return;
      expect(second.receipt).toEqual(first.receipt);
    });
  });

  it("does not leave a cache write rejection unhandled", async () => {
    const writeError = new Error("redis down");
    const failingCache: SettlementCache = {
      async get() {
        return undefined;
      },
      async set() {
        throw writeError;
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = await createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        cache: failingCache,
      })({ ...baseRequest, headers });
      // Give a floating rejection time to surface before checking.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.cacheError).toBe(writeError);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("TM-04 shared-lock duplicate settlement", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

  function countingFacilitator() {
    const inner = createMockFacilitator();
    const calls = { settle: 0 };
    const facilitator: FacilitatorClient = {
      ...inner,
      async settle(input) {
        calls.settle++;
        return inner.settle(input);
      },
    };
    return { facilitator, calls };
  }

  // ioredis-mock instances share one store, so each test uses its own prefix.
  it("answers 409 and does not settle while another process holds the lock", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:held-lock:";
    const { facilitator, calls } = countingFacilitator();
    const gate = createPaywall(config, {
      signer,
      facilitator,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });

    // The mock facilitator's nonce for this header, as the gate keys it.
    const verification = await facilitator.verify({
      payment: {
        model: "x402",
        payload: decodePaymentSignatureHeader(headers[PAYMENT_SIGNATURE_HEADER]),
      },
      offer: {
        ...config,
        amount: config.amount as string,
        resource: baseRequest.url,
        models: ["x402"],
      },
    });
    if (!verification.valid) throw new Error("expected the mock to accept the payment");
    const otherProcess = createRedisSettlementCache({ client, keyPrefix });
    await expect(otherProcess.acquire(`x402:${verification.nonce}`, 30_000)).resolves.toEqual({
      token: expect.any(String),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome).toEqual({
      kind: "rejected",
      status: 409,
      reason: "settlement in progress",
      // Issue #203: Retry-After is what tells a client this 409 is the same
      // payment still settling, safe to resend, unlike an offer mismatch.
      headers: { "retry-after": "1" },
    });
    expect(calls.settle).toBe(0);
  });

  // Regression lock for ADR-2026-11-18-redis-lock-ownership: a /settle that
  // outlives the lock TTL must not let a second process settle the same payment.
  // Fake timers drive both the renewal interval and Redis expiry (ioredis-mock
  // reads Date.now), so the outcome does not depend on how busy the machine is.
  it("keeps the lock alive while a slow settlement runs", async () => {
    vi.useFakeTimers();
    try {
      const client = new RedisMock() as unknown as RedisLikeClient;
      const keyPrefix = "gate-test:slow-settle:";
      const inner = createMockFacilitator();
      const calls = { settle: 0 };
      const slowFacilitator: FacilitatorClient = {
        ...inner,
        async settle(input) {
          calls.settle++;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return inner.settle(input);
        },
      };
      const lockTtl = { settlementLockTtlMs: 900 };
      const processA = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createRedisSettlementCache({ client, keyPrefix }),
        ...lockTtl,
      });
      const processB = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createRedisSettlementCache({ client, keyPrefix }),
        ...lockTtl,
      });

      const first = processA({ ...baseRequest, headers });
      // A retry of the same payment reaches another process long after the
      // original TTL would have expired without renewal.
      await vi.advanceTimersByTimeAsync(1_800);
      const second = await processB({ ...baseRequest, headers });
      expect(second).toEqual({
        kind: "rejected",
        status: 409,
        reason: "settlement in progress",
        // Issue #203: Retry-After is what tells a client this 409 is the same
        // payment still settling, safe to resend, unlike an offer mismatch.
        headers: { "retry-after": "1" },
      });

      await vi.advanceTimersByTimeAsync(1_500);
      expect((await first).kind).toBe("settled");
      expect(calls.settle).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lock lost during settlement instead of hiding it", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:lost-lock:";
    const inner = createMockFacilitator();
    const reported: string[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...inner,
        async settle(input) {
          // The lock disappears mid-settlement (Redis failover, eviction).
          await redis.del(`${keyPrefix}lock:x402:${input.nonce}`);
          await new Promise((resolve) => setTimeout(resolve, 120));
          return inner.settle(input);
        },
      },
      cache: createRedisSettlementCache({ client, keyPrefix }),
      settlementLockTtlMs: 90,
      onCacheError: (error) => reported.push(error.message),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.lockLost).toBe(true);
    expect(outcome.cacheError).toBeInstanceOf(Error);
    expect(reported).toHaveLength(1);
  });

  it("refuses a cache that implements only part of the lock interface", () => {
    const partial = {
      ...createInMemorySettlementCache(),
      async acquire() {
        return { token: "t" };
      },
    };
    expect(() =>
      createPaywall(config, { signer, facilitator: createMockFacilitator(), cache: partial }),
    ).toThrow(/acquire, renew and release/);
  });

  it("releases the lock after settling so a retry replays the receipt", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const { facilitator, calls } = countingFacilitator();
    const cache = createRedisSettlementCache({ client, keyPrefix: "gate-test:release:" });
    const gate = createPaywall(config, { signer, facilitator, cache });

    const first = await gate({ ...baseRequest, headers });
    const second = await gate({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;
    expect(second.replayed).toBe(true);
    expect(second.receipt).toEqual(first.receipt);
    expect(calls.settle).toBe(1);
  });

  it("reports a cache write failure to onCacheError with the cache key", async () => {
    const writeError = new Error("redis down");
    const reported: Array<{ error: Error; key: string }> = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: {
        async get() {
          return undefined;
        },
        async set() {
          throw writeError;
        },
      },
      onCacheError: (error, key) => {
        reported.push({ error, key });
      },
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(writeError);
    expect(reported[0]?.key).toMatch(/^x402:/);
  });
});

// Regression lock for ADR-2026-11-18-method-binding: one payment pays for one
// HTTP method, even when a single gate is mounted on several methods.
describe("method binding", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };

  function countingGate(cache = createInMemorySettlementCache()) {
    const inner = createMockFacilitator();
    const calls = { settle: 0 };
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...inner,
        async settle(input) {
          calls.settle++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return inner.settle(input);
        },
      },
      cache,
    });
    return { gate, calls };
  }

  it("does not serve a payment made for GET to a POST on the same URL", async () => {
    const { gate, calls } = countingGate();
    const read = await gate({ ...baseRequest, method: "GET", headers });
    expect(read.kind).toBe("settled");

    const write = await gate({ ...baseRequest, method: "POST", headers });
    expect(write).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
    expect(calls.settle).toBe(1);
  });

  it("still replays a retry of the same method", async () => {
    const { gate, calls } = countingGate();
    await gate({ ...baseRequest, method: "GET", headers });
    const retry = await gate({ ...baseRequest, method: "get", headers });
    expect(retry.kind).toBe("settled");
    if (retry.kind === "settled") expect(retry.replayed).toBe(true);
    expect(calls.settle).toBe(1);
  });

  it("settles once and rejects the other method when both arrive together", async () => {
    const { gate, calls } = countingGate();
    const [read, write] = await Promise.all([
      gate({ ...baseRequest, method: "GET", headers }),
      gate({ ...baseRequest, method: "POST", headers }),
    ]);
    expect(read.kind).toBe("settled");
    expect(write).toMatchObject({ kind: "rejected", status: 409 });
    expect(calls.settle).toBe(1);
  });

  it("refuses a Redis entry written without a method, without settling again", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:legacy-entry:";
    const { gate: writer } = countingGate(createRedisSettlementCache({ client, keyPrefix }));
    const settled = await writer({ ...baseRequest, method: "GET", headers });
    if (settled.kind !== "settled") throw new Error("expected the first request to settle");

    // An older process stored the bare receipt, with no method.
    const keys = await redis.keys(`${keyPrefix}x402:*`);
    expect(keys).toHaveLength(1);
    await redis.set(keys[0] as string, JSON.stringify(settled.receipt), "EX", 30);

    const { gate, calls } = countingGate(createRedisSettlementCache({ client, keyPrefix }));
    const outcome = await gate({ ...baseRequest, method: "GET", headers });
    expect(outcome).toMatchObject({ kind: "rejected", status: 409 });
    expect(calls.settle).toBe(0);
  });
});

describe("receipt v2 issuance and binding (#166)", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

  function gateFor(
    overrides: Partial<PaywallConfig>,
    cache: SettlementCache,
    receiptVersion?: 1 | 2,
  ) {
    return createPaywall(
      { ...config, ...overrides },
      {
        signer,
        facilitator: createMockFacilitator(),
        cache,
        ...(receiptVersion === undefined ? {} : { receiptVersion }),
      },
    );
  }

  it("issues v1 receipts unless the operator switches to v2", async () => {
    const outcome = await gateFor({}, createInMemorySettlementCache())({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.receipt.receipt.version).toBe(1);
    expect(outcome.receipt.receipt).not.toHaveProperty("offerHash");
  });

  it("issues v2 receipts bound to the offer hash and the method when switched on", async () => {
    const outcome = await gateFor(
      { facilitatorUrl: "https://facilitator.example" },
      createInMemorySettlementCache(),
      2,
    )({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    const body = outcome.receipt.receipt;
    expect(body.version).toBe(2);
    if (body.version !== 2) return;
    expect(body.method).toBe("GET");
    expect(body.offerHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verified = await verifyReceipt(outcome.receipt, Ed25519Verifier.forSigner(signer));
    expect(verified.valid).toBe(true);
  });

  it("never serves a v2 receipt for offer A to offer B, even when amount and resource match", async () => {
    const cache = createInMemorySettlementCache();
    const first = await gateFor(
      { resource: "/a", facilitatorUrl: "https://a.example" },
      cache,
      2,
    )({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");

    // Same resource, amount, asset, payee, network and model: only the
    // facilitator differs, which the six-field v1 binding cannot see.
    const replay = await gateFor(
      { resource: "/a", facilitatorUrl: "https://b.example" },
      cache,
      2,
    )({ ...baseRequest, headers });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });

  it("still serves a v2 receipt to a retry of the same offer", async () => {
    const cache = createInMemorySettlementCache();
    const gate = gateFor({ resource: "/a" }, cache, 2);
    const first = await gate({ ...baseRequest, headers });
    const retry = await gate({ ...baseRequest, headers });
    expect(retry.kind).toBe("settled");
    if (first.kind !== "settled" || retry.kind !== "settled") return;
    expect(retry.replayed).toBe(true);
    expect(retry.receipt).toEqual(first.receipt);
  });

  it("serves a v1 receipt already in the cache after the switch to v2", async () => {
    const cache = createInMemorySettlementCache();
    const before = await gateFor({ resource: "/a" }, cache)({ ...baseRequest, headers });
    expect(before.kind).toBe("settled");

    const after = await gateFor({ resource: "/a" }, cache, 2)({ ...baseRequest, headers });
    expect(after.kind).toBe("settled");
    if (before.kind !== "settled" || after.kind !== "settled") return;
    expect(after.replayed).toBe(true);
    expect(after.receipt.receipt.version).toBe(1);
    expect(after.receipt).toEqual(before.receipt);
  });

  it("refuses an unknown receipt version at construction", () => {
    expect(() =>
      createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        receiptVersion: 3 as unknown as 2,
      }),
    ).toThrow(/receiptVersion must be 1 or 2/);
  });
});

// Mutation testing (#247) found these settleOnce branches untested: the cache
// re-check after the lock is taken, the release on a failed settlement, and
// each way releasing the lock can fail. They keep one payment from settling
// twice across processes, so each one is locked in here.
describe("settlement lock edge cases (#247)", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-lock") };

  type LockCalls = { acquire: number; renew: number; release: number; get: number };

  /**
   * An in-memory cache with the lock methods, each of which a test can
   * replace. By default it behaves like a healthy shared cache.
   */
  function lockingCache(
    overrides: Partial<Pick<SettlementCache, "get" | "release" | "renew">> = {},
  ): { cache: SettlementCache; calls: LockCalls } {
    const store = createInMemorySettlementCache();
    const calls: LockCalls = { acquire: 0, renew: 0, release: 0, get: 0 };
    const cache: SettlementCache = {
      async get(key) {
        calls.get++;
        return overrides.get ? overrides.get(key) : store.get(key);
      },
      set: (key, entry) => store.set(key, entry),
      async acquire() {
        calls.acquire++;
        return { token: `lock-${calls.acquire}` };
      },
      async renew(key, lock, ttlMs) {
        calls.renew++;
        return overrides.renew ? overrides.renew(key, lock, ttlMs) : true;
      },
      async release(key, lock) {
        calls.release++;
        return overrides.release ? overrides.release(key, lock) : true;
      },
    };
    return { cache, calls };
  }

  /** The entry a first settlement writes, to play the part of another process. */
  async function settledEntry(request: TollwayRequest = { ...baseRequest, headers }) {
    let written: Parameters<SettlementCache["set"]>[1] | undefined;
    const store = createInMemorySettlementCache();
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      receiptVersion: 2,
      cache: {
        get: (key) => store.get(key),
        async set(key, entry) {
          written = entry;
          await store.set(key, entry);
        },
      },
    });
    const outcome = await gate(request);
    if (outcome.kind !== "settled" || !written) throw new Error("the first settlement failed");
    return written;
  }

  function countingSettle(): { facilitator: FacilitatorClient; settles: () => number } {
    const inner = createMockFacilitator();
    let settles = 0;
    return {
      facilitator: {
        ...inner,
        async settle(input) {
          settles++;
          return inner.settle(input);
        },
      },
      settles: () => settles,
    };
  }

  it("settles under a lock, releases it once, and reports no lost lock", async () => {
    const { cache, calls } = lockingCache();
    const reported: Error[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache,
      onCacheError: (error) => reported.push(error),
    });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.replayed).toBe(false);
    expect(outcome.lockLost).toBeUndefined();
    expect(outcome.cacheError).toBeUndefined();
    expect(calls.release).toBe(1);
    expect(reported).toEqual([]);
  });

  it("stops renewing the lock once the settlement is done", async () => {
    vi.useFakeTimers();
    try {
      const { cache, calls } = lockingCache();
      const gate = createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        cache,
        settlementLockTtlMs: 90,
      });
      const outcome = await gate({ ...baseRequest, headers });
      expect(outcome.kind).toBe("settled");
      const renewsAtRelease = calls.renew;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.renew).toBe(renewsAtRelease);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks in the cache again after taking the lock, and replays what another process settled", async () => {
    const entry = await settledEntry();
    const { cache, calls } = lockingCache({
      // Every read before the lock misses; by the time the lock is held,
      // another process has settled and written the receipt.
      get: async () => (calls.acquire === 0 ? undefined : entry),
    });
    const { facilitator, settles } = countingSettle();
    const gate = createPaywall(config, { signer, facilitator, cache, receiptVersion: 2 });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.replayed).toBe(true);
    expect(outcome.receipt).toEqual(entry.receipt);
    expect(settles()).toBe(0);
    expect(calls.release).toBe(1);
  });

  it("releases the lock when the settlement throws, and rethrows", async () => {
    const { cache, calls } = lockingCache();
    const failingSigner = {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      async sign(): Promise<Uint8Array> {
        throw new Error("signing key unavailable");
      },
    };
    const gate = createPaywall(config, {
      signer: failingSigner,
      facilitator: createMockFacilitator(),
      cache,
    });
    await expect(gate({ ...baseRequest, headers })).rejects.toThrow("signing key unavailable");
    expect(calls.release).toBe(1);
  });

  it("keeps the receipt when releasing fails after a fresh settlement, and reports the failure", async () => {
    const releaseFailure = new Error("redis went away");
    const { cache } = lockingCache({
      async release() {
        throw releaseFailure;
      },
    });
    const reported: Array<{ error: Error; key: string }> = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache,
      onCacheError: (error, key) => reported.push({ error, key }),
    });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.cacheError).toBe(releaseFailure);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(releaseFailure);
    expect(reported[0]?.key).toMatch(/^x402:/);
  });

  it("surfaces a release failure when nothing was settled by this request", async () => {
    const entry = await settledEntry();
    const { cache, calls } = lockingCache({
      get: async () => (calls.acquire === 0 ? undefined : entry),
      async release() {
        throw new Error("redis went away");
      },
    });
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache,
      receiptVersion: 2,
    });
    await expect(gate({ ...baseRequest, headers })).rejects.toThrow("redis went away");
  });

  it("reports a lock that was no longer held at release, even with no renewal failure", async () => {
    const { cache } = lockingCache({ release: async () => false });
    const reported: Error[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache,
      onCacheError: (error) => reported.push(error),
    });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.lockLost).toBe(true);
    expect(outcome.cacheError).toBeInstanceOf(Error);
    expect(reported).toHaveLength(1);
  });

  it("still settles when the lock is lost and no onCacheError handler is set", async () => {
    const { cache } = lockingCache({ release: async () => false });
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator(), cache });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.lockLost).toBe(true);
  });

  it("does not flag a lost lock on a receipt another process settled", async () => {
    const entry = await settledEntry();
    const { cache, calls } = lockingCache({
      get: async () => (calls.acquire === 0 ? undefined : entry),
      release: async () => false,
    });
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache,
      receiptVersion: 2,
    });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.replayed).toBe(true);
    expect(outcome.lockLost).toBeUndefined();
  });

  it("stops renewing the lock after a settlement that throws", async () => {
    vi.useFakeTimers();
    try {
      const { cache, calls } = lockingCache();
      const gate = createPaywall(config, {
        signer: {
          keyId: signer.keyId,
          algorithm: signer.algorithm,
          async sign(): Promise<Uint8Array> {
            throw new Error("signing key unavailable");
          },
        },
        facilitator: createMockFacilitator(),
        cache,
        settlementLockTtlMs: 90,
      });
      await expect(gate({ ...baseRequest, headers })).rejects.toThrow("signing key unavailable");
      const renewsAtRelease = calls.renew;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.renew).toBe(renewsAtRelease);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps a release failure that is not an Error, and settles without an onCacheError handler", async () => {
    const { cache } = lockingCache({
      async release() {
        throw "connection reset";
      },
    });
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator(), cache });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.cacheError).toBeInstanceOf(Error);
    expect(outcome.cacheError?.message).toBe("settlement lock release failed");
    expect(outcome.cacheError?.cause).toBe("connection reset");
  });

  it("reports a cache write failure only to the request that settled, not to one that waited", async () => {
    const inner = createMockFacilitator();
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...inner,
        async settle(input) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return inner.settle(input);
        },
      },
      cache: {
        get: async () => undefined,
        async set() {
          throw new Error("cache write failed");
        },
      },
      onCacheError: () => {},
    });
    const [first, second] = await Promise.all([
      gate({ ...baseRequest, headers }),
      gate({ ...baseRequest, headers }),
    ]);
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;
    expect(first.cacheError).toBeInstanceOf(Error);
    expect(second.replayed).toBe(true);
    expect(second).not.toHaveProperty("cacheError");
  });

  it("refuses a cached v2 receipt whose signed method differs from the entry's method", async () => {
    // A POST receipt stored under a GET entry: the entry's method matches the
    // request, but the receipt itself paid for POST. Only the check on the
    // signed body catches it.
    const postEntry = await settledEntry({ ...baseRequest, method: "POST", headers });
    const tampered = { ...postEntry, method: "GET" };
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      receiptVersion: 2,
      cache: {
        get: async () => tampered,
        async set() {},
      },
    });
    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });
});
