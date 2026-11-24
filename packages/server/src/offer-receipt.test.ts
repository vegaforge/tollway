import { Ed25519Signer, Ed25519Verifier } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall } from "./gate.js";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "./headers.js";
import {
  decodeOfferReceiptJws,
  ed25519PublicKeyToDidKey,
  OFFER_RECEIPT_EXTENSION_KEY,
  type OfferExtensionPayload,
  type ReceiptExtensionPayload,
  verifyOfferReceiptJws,
} from "./offer-receipt.js";

const PAYEE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function x402SignatureHeader(resource: string, amount: string, nonce = "nonce-1"): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: resource },
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: ASSET,
      amount,
      payTo: PAYEE,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction: `tx-${nonce}` },
  });
}

describe("x402 offer-receipt extension (#172)", () => {
  it("does not emit offer-receipt extension unless opted in", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const gate = createPaywall(
      { amount: "1000", asset: ASSET, payTo: PAYEE, network: "testnet" },
      { signer, facilitator: createMockFacilitator() },
    );

    const unpaid = await gate({ method: "GET", url: "https://api.example/data", headers: {} });
    expect(unpaid.kind).toBe("payment-required");
    if (unpaid.kind === "payment-required") {
      expect(unpaid.challenge.extensions?.[OFFER_RECEIPT_EXTENSION_KEY]).toBeUndefined();
    }

    const paid = await gate({
      method: "GET",
      url: "https://api.example/data",
      headers: { "payment-signature": x402SignatureHeader("https://api.example/data", "1000") },
    });
    expect(paid.kind).toBe("settled");
    if (paid.kind === "settled") {
      const settleResponse = decodePaymentResponseHeader(paid.headers[PAYMENT_RESPONSE_HEADER]!);
      expect(settleResponse.extensions?.[OFFER_RECEIPT_EXTENSION_KEY]).toBeUndefined();
    }
  });

  it("attaches signed offer and receipt JWS when offerReceipt is enabled (txHash omitted by default)", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);
    const gate = createPaywall(
      {
        amount: "2500",
        asset: ASSET,
        payTo: PAYEE,
        network: "testnet",
        offerReceipt: true,
      },
      {
        signer,
        facilitator: createMockFacilitator(),
        cache: createInMemorySettlementCache(),
        clock: () => 1_700_000_000_000,
      },
    );

    const unpaid = await gate({ method: "GET", url: "https://api.example/data", headers: {} });
    expect(unpaid.kind).toBe("payment-required");
    if (unpaid.kind === "payment-required") {
      const decodedHeader = decodePaymentRequiredHeader(unpaid.headers[PAYMENT_REQUIRED_HEADER]!);
      const ext = decodedHeader.extensions?.[OFFER_RECEIPT_EXTENSION_KEY] as {
        info: { offers: string[] };
      };
      expect(ext.info.offers).toHaveLength(1);
      const verifiedOffer = await verifyOfferReceiptJws<OfferExtensionPayload>(
        ext.info.offers[0]!,
        verifier,
        signer.keyId,
      );
      expect(verifiedOffer.valid).toBe(true);
      if (verifiedOffer.valid) {
        expect(verifiedOffer.header.alg).toBe("EdDSA");
        expect(verifiedOffer.header.kid).toBe(ed25519PublicKeyToDidKey(signer.publicKey));
        expect(verifiedOffer.payload).toEqual({
          version: 1,
          resourceUrl: "https://api.example/data",
          scheme: "exact",
          network: "stellar:testnet",
          asset: ASSET,
          payTo: PAYEE,
          amount: "2500",
          validUntil: 1_700_000_060,
        });
      }
    }

    const paid = await gate({
      method: "GET",
      url: "https://api.example/data",
      headers: { "payment-signature": x402SignatureHeader("https://api.example/data", "2500") },
    });
    expect(paid.kind).toBe("settled");
    if (paid.kind === "settled") {
      const settleResponse = decodePaymentResponseHeader(paid.headers[PAYMENT_RESPONSE_HEADER]!);
      const ext = settleResponse.extensions?.[OFFER_RECEIPT_EXTENSION_KEY] as {
        info: { receipt: string };
      };
      const verifiedReceipt = await verifyOfferReceiptJws<ReceiptExtensionPayload>(
        ext.info.receipt,
        verifier,
        signer.keyId,
      );
      expect(verifiedReceipt.valid).toBe(true);
      if (verifiedReceipt.valid) {
        expect(verifiedReceipt.payload.network).toBe("stellar:testnet");
        expect(verifiedReceipt.payload.resourceUrl).toBe("https://api.example/data");
        expect(verifiedReceipt.payload.payer).toBe(paid.receipt.receipt.payer);
        expect(verifiedReceipt.payload.transaction).toBeUndefined();
      }
    }
  });

  it("includes transaction hash when includeTxHash is true and respects custom kid", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const gate = createPaywall(
      {
        amount: "500",
        asset: ASSET,
        payTo: PAYEE,
        network: "testnet",
        offerReceipt: {
          includeTxHash: true,
          kid: "did:web:api.example#key-1",
          validUntilSeconds: 120,
        },
      },
      { signer, facilitator: createMockFacilitator(), clock: () => 1_700_000_000_000 },
    );

    const paid = await gate({
      method: "GET",
      url: "https://api.example/data",
      headers: { "payment-signature": x402SignatureHeader("https://api.example/data", "500") },
    });
    expect(paid.kind).toBe("settled");
    if (paid.kind === "settled") {
      const settleResponse = decodePaymentResponseHeader(paid.headers[PAYMENT_RESPONSE_HEADER]!);
      const ext = settleResponse.extensions?.[OFFER_RECEIPT_EXTENSION_KEY] as {
        info: { receipt: string };
      };
      const decoded = decodeOfferReceiptJws<ReceiptExtensionPayload>(ext.info.receipt);
      expect(decoded.header.kid).toBe("did:web:api.example#key-1");
      expect(decoded.payload.transaction).toBeDefined();
      expect(paid.receipt.receipt.settlement.kind).toBe("transaction");
      if (paid.receipt.receipt.settlement.kind === "transaction") {
        expect(decoded.payload.transaction).toBe(paid.receipt.receipt.settlement.txHash);
      }
    }
  });
});
