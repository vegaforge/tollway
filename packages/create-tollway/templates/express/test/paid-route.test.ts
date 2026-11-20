import { type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import {
  decodeHeader,
  encodePaymentSignatureHeader,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, signer } from "../src/index.js";

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "10000",
      payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction: "mock-payment" },
  });
}

describe("paid Express route", () => {
  it("challenges, settles in mock mode, and returns a verified receipt", async () => {
    const challenge = await request(app).get("/api/paid");
    expect(challenge.status).toBe(402);
    const paid = await request(app).get("/api/paid").set(PAYMENT_SIGNATURE_HEADER, paymentHeader());
    expect(paid.status).toBe(200);
    const signed = decodeHeader<SignedReceipt>(
      paid.headers[TOLLWAY_RECEIPT_HEADER.toLowerCase()] as string,
    );
    expect(await verifyReceipt(signed, signer)).toMatchObject({ valid: true });
  });
});
