import { Ed25519Signer } from "@tollway/core";
import {
  createMockFacilitator,
  createPaywall,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@tollway/server";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fastifyPaywall, RECEIPT_REQUEST_KEY } from "./index.js";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
};

async function buildApp() {
  const signer = await Ed25519Signer.generate("test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

  const app = Fastify();
  app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => {
    const receipt = request[RECEIPT_REQUEST_KEY];
    if (!receipt) throw new Error("receipt missing on request");
    return { quote: 42, receiptId: receipt.receipt.id };
  });
  await app.ready();
  return app;
}

describe("fastifyPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/quotes/latest" });

      expect(response.statusCode).toBe(402);
      const challenge = response.json<{ amount: string }>();
      expect(challenge.amount).toBe("10000");
    } finally {
      await app.close();
    }
  });

  it("runs the wrapped handler and adds the PAYMENT-RESPONSE header once payment settles", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["payment-response"]).toBeTruthy();
      const body = response.json<{ quote: number; receiptId: string }>();
      expect(body.quote).toBe(42);
      expect(body.receiptId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("answers the rejection status when the gate rejects the payment", async () => {
    // Force a rejected outcome by routing to a non-x402 model the gate has
    // not implemented yet; the gate returns kind="rejected" with status 501.
    const signer = await Ed25519Signer.generate("test-key-reject");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      router: {
        async decide() {
          // RouteReason is a closed union; "override" fits the intent of a
          // stub router that pins the model regardless of the offer.
          return { model: "mpp-channel", reason: "override" };
        },
      },
    });

    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async () => ({ quote: 42 }));
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
      });

      expect(response.statusCode).toBe(501);
      const body = response.json<{ error?: string; quote?: number }>();
      expect(body.quote).toBeUndefined();
      expect(body.error).toMatch(/mpp-channel/);
    } finally {
      await app.close();
    }
  });
});
