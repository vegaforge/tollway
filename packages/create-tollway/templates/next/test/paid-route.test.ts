import { type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import {
  decodeHeader,
  encodePaymentSignatureHeader,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { describe, expect, it } from "vitest";
import { GET, signer } from "../app/api/paid/route.js";

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

describe("paid Next.js route", () => {
  it("challenges, settles in mock mode, and returns a signed receipt", async () => {
    const challenge = await GET(new Request("http://localhost/api/paid"));
    expect(challenge.status).toBe(402);
    const paid = await GET(
      new Request("http://localhost/api/paid", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      }),
    );
    expect(paid.status).toBe(200);
    const encoded = paid.headers.get(TOLLWAY_RECEIPT_HEADER);
    expect(encoded).toBeTruthy();
    const signed = decodeHeader<SignedReceipt>(encoded ?? "");
    expect(await verifyReceipt(signed, signer)).toMatchObject({ valid: true });
  });
});
