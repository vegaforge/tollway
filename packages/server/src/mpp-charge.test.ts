import type { MppChargePayment, PaymentOffer } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createMockMppChargeHandler } from "./mpp-charge.js";

const offer: PaymentOffer = {
  resource: "https://api.example.com/quotes/latest",
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  models: ["mpp-charge"],
};

const payment: MppChargePayment = { model: "mpp-charge", payload: "AAAA-mpp-charge-payload" };

describe("createMockMppChargeHandler", () => {
  it("verifies a non-empty mpp charge payload", async () => {
    const handler = createMockMppChargeHandler();
    const result = await handler.verify({ payment, offer });
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
      offer,
    });
    expect(result).toEqual({ valid: false, reason: "empty mpp charge payload" });
  });

  it("settles a verified payment and returns a tx hash", async () => {
    const handler = createMockMppChargeHandler();
    const verification = await handler.verify({ payment, offer });
    if (!verification.valid) throw new Error("expected verification to be valid");

    const result = await handler.settle({
      payment,
      offer,
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
    const first = await handler.verify({ payment, offer });
    const second = await handler.verify({ payment, offer });
    if (!first.valid || !second.valid) throw new Error("expected both verifications to be valid");
    expect(first.nonce).toBe(second.nonce);
  });
});
