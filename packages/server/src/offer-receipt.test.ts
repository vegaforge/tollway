import {
  EcdsaP256Signer,
  Ed25519Signer,
  Ed25519Verifier,
  type ReceiptSigner,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import type { PaymentRequired } from "@x402/core/types";
import {
  createJWS,
  decodeSignedOffers,
  extractJWSHeader,
  extractOffersFromPaymentRequired,
  extractReceiptFromResponse,
  findAcceptsObjectFromSignedOffer,
  isJWSSignedOffer,
  isJWSSignedReceipt,
  type JWSSignedOffer,
  type JWSSignedReceipt,
  verifyOfferSignatureJWS,
  verifyReceiptMatchesOffer,
  verifyReceiptSignatureJWS,
} from "@x402/extensions/offer-receipt";
import { describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall, type PaywallConfig, type PaywallDeps } from "./gate.js";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "./headers.js";
import {
  createOfferReceiptIssuer,
  createOfferReceiptJwsSigner,
  didKeyFromEd25519PublicKey,
} from "./offer-receipt.js";

const PAYEE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const URL = "https://api.example/data";

const baseConfig = {
  amount: "2500",
  asset: ASSET,
  payTo: PAYEE,
  network: "testnet",
} satisfies PaywallConfig;

/** Pays a 402 the way a stock x402 V2 client does: `accepts[0]` becomes `accepted`. */
function payFrom(challenge: PaymentRequired, transaction: string): string {
  const accepted = challenge.accepts[0];
  if (!accepted) throw new Error("the 402 offers no payment requirements");
  return encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction } });
}

/** A clock the test moves by hand, starting at the real time so recency checks pass. */
function manualClock() {
  let now = Date.now();
  return {
    now: () => now,
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

async function gateWith(
  offerReceipt: PaywallConfig["offerReceipt"],
  deps: Partial<Omit<PaywallDeps, "signer">> & { signer?: Ed25519Signer } = {},
  config: Partial<Extract<PaywallConfig, { amount: unknown }>> = {},
) {
  const signer = deps.signer ?? (await Ed25519Signer.generate("key-1"));
  const gate = createPaywall(
    { ...baseConfig, ...config, ...(offerReceipt === undefined ? {} : { offerReceipt }) },
    { facilitator: createMockFacilitator(), ...deps, signer },
  );
  return { gate, signer };
}

async function challengeOf(gate: ReturnType<typeof createPaywall>): Promise<PaymentRequired> {
  const outcome = await gate({ method: "GET", url: URL, headers: {} });
  if (outcome.kind !== "payment-required") throw new Error(`expected a 402, got ${outcome.kind}`);
  const header = outcome.headers[PAYMENT_REQUIRED_HEADER];
  if (!header) throw new Error("402 without PAYMENT-REQUIRED");
  return decodePaymentRequiredHeader(header);
}

function onlyJwsOffer(challenge: PaymentRequired): JWSSignedOffer {
  const offers = extractOffersFromPaymentRequired(challenge);
  expect(offers).toHaveLength(1);
  const offer = offers[0];
  if (!offer || !isJWSSignedOffer(offer)) throw new Error("expected one JWS offer");
  return offer;
}

describe("offer-receipt JWS signer adapter (#172)", () => {
  it("derives a did:key that @x402/extensions resolves for Ed25519, with EdDSA", async () => {
    const signer = await Ed25519Signer.generate("key-ed");
    const jws = createOfferReceiptJwsSigner(signer);
    expect(jws.algorithm).toBe("EdDSA");
    expect(jws.kid).toBe(didKeyFromEd25519PublicKey(signer.publicKey));
    expect(jws.kid.startsWith("did:key:z6Mk")).toBe(true);

    const token = await createJWS({ hello: "world" }, jws);
    expect(extractJWSHeader(token)).toEqual({ alg: "EdDSA", kid: jws.kid });
    // No key passed: the library resolves it from the did:key alone.
    const verified = await verifyOfferSignatureJWS({ format: "jws", signature: token });
    expect(verified).toEqual({ hello: "world" });
  });

  it("derives a did:jwk for an ES256 signer that the library verifies", async () => {
    const signer = await EcdsaP256Signer.generate("key-p256");
    const jws = createOfferReceiptJwsSigner(signer);
    expect(jws.algorithm).toBe("ES256");
    expect(jws.kid.startsWith("did:jwk:")).toBe(true);
    const token = await createJWS({ n: 1 }, jws);
    expect(await verifyReceiptSignatureJWS({ format: "jws", signature: token })).toEqual({ n: 1 });
  });

  it("uses an explicit did:web kid and rejects a non-DID kid", async () => {
    const signer = await Ed25519Signer.generate("key-web");
    expect(createOfferReceiptJwsSigner(signer, "did:web:api.example#key-1").kid).toBe(
      "did:web:api.example#key-1",
    );
    expect(() => createOfferReceiptJwsSigner(signer, "key-1")).toThrow(/must be a DID/);
  });

  it("rejects at construction an algorithm JWS cannot name, or a key it cannot derive", () => {
    const custom: ReceiptSigner = {
      keyId: "kms",
      algorithm: "RS256",
      sign: async () => new Uint8Array(64),
    };
    expect(() => createOfferReceiptJwsSigner(custom)).toThrow(/no JWS equivalent/);
    const opaque: ReceiptSigner = { ...custom, algorithm: "Ed25519" };
    expect(() => createOfferReceiptJwsSigner(opaque)).toThrow(/set offerReceipt.kid/);
    expect(createOfferReceiptJwsSigner(opaque, "did:web:api.example").kid).toBe(
      "did:web:api.example",
    );
  });

  it("matches the multibase did:key test vector for the all-zero key", () => {
    // did:key spec: 0xed01 || 32 zero bytes encodes to this identifier.
    expect(didKeyFromEd25519PublicKey(new Uint8Array(32))).toBe(
      "did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP",
    );
  });
});

describe("gate offer-receipt extension (#172)", () => {
  it("is off by default and leaves challenge and settlement responses unchanged", async () => {
    const plain = await gateWith(undefined);
    const disabled = await gateWith(false, { signer: plain.signer });

    const challenge = await challengeOf(plain.gate);
    expect(challenge.extensions).toBeUndefined();
    expect(challenge).toEqual(await challengeOf(disabled.gate));

    const paid = await plain.gate({
      method: "GET",
      url: URL,
      headers: { "payment-signature": payFrom(challenge, "tx-off") },
    });
    if (paid.kind !== "settled") throw new Error(`expected settled, got ${paid.kind}`);
    const response = decodePaymentResponseHeader(paid.headers[PAYMENT_RESPONSE_HEADER] ?? "");
    expect(Object.keys(response).sort()).toEqual(["network", "success", "transaction"]);
  });

  it("puts one valid signed offer per requirement where the x402 client reads it", async () => {
    const clock = manualClock();
    const { gate, signer } = await gateWith(true, { clock: clock.now });
    const challenge = await challengeOf(gate);
    const offer = onlyJwsOffer(challenge);
    expect(offer.acceptIndex).toBe(0);

    const payload = await verifyOfferSignatureJWS(offer);
    const requirement = challenge.accepts[0];
    expect(payload).toEqual({
      version: 1,
      resourceUrl: URL,
      scheme: requirement?.scheme,
      network: "stellar:testnet",
      asset: ASSET,
      payTo: PAYEE,
      amount: "2500",
      validUntil: Math.floor(clock.now() / 1000) + 60,
    });
    expect(extractJWSHeader(offer.signature).kid).toBe(
      didKeyFromEd25519PublicKey(signer.publicKey),
    );
    const [decoded] = decodeSignedOffers([offer]);
    if (!decoded) throw new Error("no decoded offer");
    expect(findAcceptsObjectFromSignedOffer(decoded, challenge.accepts)).toEqual(requirement);
  });

  it("keeps discovery and offer-receipt extensions side by side", async () => {
    const { gate } = await gateWith(
      true,
      {},
      { discovery: { kind: "query", description: "weather" } },
    );
    const challenge = await challengeOf(gate);
    expect(Object.keys(challenge.extensions ?? {}).sort()).toEqual(["bazaar", "offer-receipt"]);
  });

  it("signs no offer when the route does not take x402 payments", async () => {
    const { gate } = await gateWith(true, {}, { models: ["mpp-charge"] });
    const challenge = await challengeOf(gate);
    expect(challenge.extensions).toBeUndefined();
  });

  it("reuses a signed offer until half its window is gone, then signs a fresh one", async () => {
    const clock = manualClock();
    const signer = await Ed25519Signer.generate("key-cache");
    const sign = vi.spyOn(signer, "sign");
    const { gate } = await gateWith(true, { signer, clock: clock.now });

    const first = onlyJwsOffer(await challengeOf(gate));
    clock.advance(29);
    const second = onlyJwsOffer(await challengeOf(gate));
    expect(second.signature).toBe(first.signature);
    expect(sign).toHaveBeenCalledTimes(1);

    clock.advance(1);
    const third = onlyJwsOffer(await challengeOf(gate));
    expect(third.signature).not.toBe(first.signature);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("signs a new offer when the price changes", async () => {
    const signer = await Ed25519Signer.generate("key-price");
    let price = 100;
    const { gate } = await gateWith(
      true,
      { signer },
      {
        amount: () => String(price++),
        minAmount: "1",
        maxAmount: "100000",
        quoteSecret: "offer receipt test quote secret",
      },
    );
    const first = await verifyOfferSignatureJWS(onlyJwsOffer(await challengeOf(gate)));
    const second = await verifyOfferSignatureJWS(onlyJwsOffer(await challengeOf(gate)));
    expect([first.amount, second.amount]).toEqual(["100", "101"]);
  });

  it("drops a failed signature from the cache instead of serving the failure", async () => {
    const signer = await Ed25519Signer.generate("key-fail");
    const sign = vi.spyOn(signer, "sign").mockRejectedValueOnce(new Error("kms down"));
    const { gate } = await gateWith(true, { signer });
    await expect(gate({ method: "GET", url: URL, headers: {} })).rejects.toThrow("kms down");
    sign.mockRestore();
    expect(onlyJwsOffer(await challengeOf(gate)).signature).toBeTruthy();
  });

  it("bounds the offer cache", async () => {
    const signer = await Ed25519Signer.generate("key-bound");
    const issuer = createOfferReceiptIssuer(signer, {}, 60);
    const requirement = (await challengeOf((await gateWith(undefined)).gate)).accepts;
    const sign = vi.spyOn(signer, "sign");
    const now = Date.now();
    for (let i = 0; i <= 256; i += 1) {
      await issuer.offers(`${URL}?page=${i}`, requirement, now);
    }
    // The first entry was evicted, so asking for it again signs once more.
    await issuer.offers(`${URL}?page=0`, requirement, now);
    expect(sign).toHaveBeenCalledTimes(258);
    // The most recent one is still cached.
    await issuer.offers(`${URL}?page=256`, requirement, now);
    expect(sign).toHaveBeenCalledTimes(258);
  });

  it("never lets an offer outlive the gate's acceptance window", async () => {
    await expect(gateWith({ offerValiditySeconds: 61 })).rejects.toThrow(/acceptance window/);
    await expect(
      gateWith({ offerValiditySeconds: 120 }, {}, { maxTimeoutSeconds: 300 }),
    ).resolves.toBeDefined();
    // A dynamic price is honoured only as long as its quote.
    await expect(
      gateWith(
        { offerValiditySeconds: 120 },
        {},
        {
          maxTimeoutSeconds: 300,
          quoteTtlSeconds: 90,
          amount: () => "100",
          minAmount: "1",
          maxAmount: "1000",
          quoteSecret: "offer receipt window secret",
        },
      ),
    ).rejects.toThrow(/acceptance window of 90/);
    await expect(gateWith({ offerValiditySeconds: 0 })).rejects.toThrow(/positive integer/);
  });

  it("returns a receipt on success that a stock client verifies against the offer", async () => {
    const clock = manualClock();
    const signer = await Ed25519Signer.generate("key-round-trip");
    const { gate } = await gateWith(true, {
      signer,
      clock: clock.now,
      cache: createInMemorySettlementCache(),
    });
    const challenge = await challengeOf(gate);
    const [decodedOffer] = decodeSignedOffers(extractOffersFromPaymentRequired(challenge));
    if (!decodedOffer) throw new Error("no offer");

    const paid = await gate({
      method: "GET",
      url: URL,
      headers: { "payment-signature": payFrom(challenge, "tx-round-trip") },
    });
    if (paid.kind !== "settled") throw new Error(`expected settled, got ${paid.kind}`);
    // Read it exactly as a client does, from an HTTP response.
    const signed = extractReceiptFromResponse(new Response(null, { headers: paid.headers }));
    if (!signed || !isJWSSignedReceipt(signed))
      throw new Error("no JWS receipt in PAYMENT-RESPONSE");
    const payload = await verifyReceiptSignatureJWS(signed);
    expect(verifyReceiptMatchesOffer(signed, decodedOffer, [paid.receipt.receipt.payer])).toBe(
      true,
    );

    // Field by field, the extension receipt agrees with the Tollway receipt.
    const tollway = paid.receipt.receipt;
    expect((await verifyReceipt(paid.receipt, Ed25519Verifier.forSigner(signer))).valid).toBe(true);
    expect(payload).toEqual({
      version: 1,
      network: "stellar:testnet",
      resourceUrl: tollway.resource,
      payer: tollway.payer,
      issuedAt: Math.floor(Date.parse(tollway.issuedAt) / 1000),
    });
    // Private by default: no transaction hash.
    expect("transaction" in payload).toBe(false);
  });

  it("includes the transaction hash only when asked, matching the Tollway receipt", async () => {
    const { gate } = await gateWith({ includeTxHash: true, kid: "did:web:api.example#key-1" });
    const challenge = await challengeOf(gate);
    const paid = await gate({
      method: "GET",
      url: URL,
      headers: { "payment-signature": payFrom(challenge, "tx-hash") },
    });
    if (paid.kind !== "settled") throw new Error(`expected settled, got ${paid.kind}`);
    const signed = extractReceiptFromResponse(new Response(null, { headers: paid.headers }));
    if (!signed || !isJWSSignedReceipt(signed)) throw new Error("no JWS receipt");
    const receipt: JWSSignedReceipt = signed;
    expect(extractJWSHeader(receipt.signature).kid).toBe("did:web:api.example#key-1");
    const settlement = paid.receipt.receipt.settlement;
    if (settlement.kind !== "transaction") throw new Error("expected a transaction settlement");
    const response = decodePaymentResponseHeader(paid.headers[PAYMENT_RESPONSE_HEADER] ?? "");
    expect(response.transaction).toBe(settlement.txHash);
    const payload = JSON.parse(
      Buffer.from(receipt.signature.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { transaction?: string };
    expect(payload.transaction).toBe(settlement.txHash);
  });

  it("attaches no receipt when the payment is rejected", async () => {
    const { gate } = await gateWith(true, {
      facilitator: {
        ...createMockFacilitator(),
        async verify() {
          return { valid: false, reason: "insufficient funds" };
        },
      },
    });
    const challenge = await challengeOf(gate);
    const outcome = await gate({
      method: "GET",
      url: URL,
      headers: { "payment-signature": payFrom(challenge, "tx-rejected") },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.headers?.[PAYMENT_RESPONSE_HEADER]).toBeUndefined();
    }
  });
});
