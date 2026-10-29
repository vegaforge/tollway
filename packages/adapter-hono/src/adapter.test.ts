import { Ed25519Signer } from "@tollway/core";
import {
  createMockFacilitator,
  createPaywall,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@tollway/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { honoPaywall, RECEIPT_CONTEXT_KEY } from "./index.js";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
};

async function buildApp() {
  const signer = await Ed25519Signer.generate("test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

  const app = new Hono();
  app.get("/quotes/latest", honoPaywall(gate), (c) => {
    const signed = c.get(RECEIPT_CONTEXT_KEY);
    return c.json({ quote: 42, receiptId: signed.receipt.id });
  });
  return app;
}

describe("honoPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const app = await buildApp();
    const response = await app.request("/quotes/latest");

    expect(response.status).toBe(402);
    const challenge = (await response.json()) as { amount: string };
    expect(challenge.amount).toBe("10000");
  });

  it("serves the resource once a valid payment is supplied", async () => {
    const app = await buildApp();
    const response = await app.request("/quotes/latest", {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    const body = (await response.json()) as { quote: number; receiptId: string };
    expect(body.quote).toBe(42);
    expect(body.receiptId).toBeTruthy();
  });
});
