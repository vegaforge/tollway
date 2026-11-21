import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "./headers.js";

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "10000",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
} as const;

describe("x402 V2 header encoding", () => {
  it("round trips a PaymentRequired in standard base64", () => {
    const challenge: PaymentRequired = {
      x402Version: 2,
      resource: { url: "/quotes/latest" },
      accepts: [requirements],
    };
    const header = encodePaymentRequiredHeader(challenge);
    expect(header).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(decodePaymentRequiredHeader(header)).toEqual(challenge);
  });

  it("round trips a PaymentPayload in standard base64", () => {
    const payment: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: "AAAAAgAAAAB4NDAyLXRyYW5zYWN0aW9u" },
    };
    const header = encodePaymentSignatureHeader(payment);
    expect(header).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(decodePaymentSignatureHeader(header)).toEqual(payment);
  });

  it("round trips a SettleResponse in standard base64", () => {
    const settlement: SettleResponse = {
      success: true,
      transaction: "d".repeat(64),
      network: "stellar:testnet",
    };
    const header = encodePaymentResponseHeader(settlement);
    expect(decodePaymentResponseHeader(header)).toEqual(settlement);
  });

  it("rejects a base64url value, which a V2 client never sends", () => {
    const payment: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: "t" },
      // U+0080 U+00BE make standard base64 spell a byte with `+`, so the
      // base64url form contains `-`.
      extensions: { probe: "\u0080\u00be" },
    };
    const standard = encodePaymentSignatureHeader(payment);
    const base64url = Buffer.from(standard, "base64").toString("base64url");
    expect(base64url).not.toBe(standard);
    expect(() => decodePaymentSignatureHeader(base64url)).toThrow(
      "Invalid payment signature header",
    );
  });

  it("keeps the Tollway receipt in base64url, which the client accepts", () => {
    const receipt = { id: "r-1", amount: "10000", note: "ü" };
    expect(decodeHeader(encodeHeader(receipt))).toEqual(receipt);
  });
});
