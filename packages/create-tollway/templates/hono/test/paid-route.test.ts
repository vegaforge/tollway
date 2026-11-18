import { type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import {
  decodeHeader,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@vegaforge/tollway-server";
import { describe, expect, it } from "vitest";
import { app, signer } from "../src/index.js";

describe("paid Hono route", () => {
  it("challenges, settles in mock mode, and returns a verified receipt", async () => {
    const challenge = await app.request("/api/paid");
    expect(challenge.status).toBe(402);
    const paid = await app.request("/api/paid", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-payment" },
    });
    expect(paid.status).toBe(200);
    const encoded = paid.headers.get(PAYMENT_RESPONSE_HEADER);
    expect(encoded).toBeTruthy();
    const signed = decodeHeader<SignedReceipt>(encoded ?? "");
    expect(await verifyReceipt(signed, signer)).toMatchObject({ valid: true });
  });
});
