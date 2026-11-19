import { type SignedReceipt, verifyReceipt } from "@vegaforge/tollway-core";
import { decodeHeader, PAYMENT_SIGNATURE_HEADER } from "@vegaforge/tollway-server";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, signer } from "../src/index.js";

describe("paid Express route", () => {
  it("challenges, settles in mock mode, and returns a verified receipt", async () => {
    const challenge = await request(app).get("/api/paid");
    expect(challenge.status).toBe(402);
    const paid = await request(app).get("/api/paid").set(PAYMENT_SIGNATURE_HEADER, "mock-payment");
    expect(paid.status).toBe(200);
    const signed = decodeHeader<SignedReceipt>(paid.headers["payment-response"] as string);
    expect(await verifyReceipt(signed, signer)).toMatchObject({ valid: true });
  });
});
