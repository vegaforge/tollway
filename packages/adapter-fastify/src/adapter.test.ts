import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createMockMppChargeHandler,
  createPaywall,
  type MppChargeHandler,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
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

// Regression lock for ADR-2026-11-18-method-binding.
describe("fastifyPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    const app = Fastify();
    app.route({
      method: ["GET", "POST"],
      url: "/report",
      preHandler: fastifyPaywall(gate),
      handler: async () => ({ ok: true }),
    });
    await app.ready();
    const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry-method" };
    try {
      const read = await app.inject({ method: "GET", url: "/report", headers });
      expect(read.statusCode).toBe(200);
      const write = await app.inject({ method: "POST", url: "/report", headers });
      expect(write.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

// MPP charge through the adapter: the challenge headers reach the client on
// the 402, an Authorization: Payment credential settles, and a refused
// credential comes back as the rejection status.
async function mppGate() {
  const signer = await Ed25519Signer.generate("test-key-mpp");
  const base = createMockMppChargeHandler();
  const handler: MppChargeHandler = {
    ...base,
    async challenge() {
      return {
        status: 402,
        headers: { "www-authenticate": 'Payment id="test"', "cache-control": "no-store" },
        body: null,
      };
    },
    async verify(input) {
      if (input.payment.payload === "Payment refused") {
        return { valid: false, reason: "mpp challenge was not issued by this server" };
      }
      return base.verify(input);
    },
  };
  return createPaywall(
    { ...config, models: ["x402", "mpp-charge"] },
    { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
  );
}

describe("fastifyPaywall with mpp-charge", () => {
  async function build() {
    const gate = await mppGate();
    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => ({
      receiptModel: request[RECEIPT_REQUEST_KEY]?.receipt.model,
    }));
    await app.ready();
    return app;
  }

  it("sends the MPP challenge headers with the 402", async () => {
    const app = await build();
    try {
      const response = await app.inject({ method: "GET", url: "/quotes/latest" });
      expect(response.statusCode).toBe(402);
      expect(response.headers["www-authenticate"]).toBe('Payment id="test"');
      expect(response.headers["payment-required"]).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("settles an Authorization: Payment credential", async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: "Payment ok" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ receiptModel: string }>().receiptModel).toBe("mpp-charge");
    } finally {
      await app.close();
    }
  });

  it("answers a refused credential with the rejection status", async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/quotes/latest",
        headers: { authorization: "Payment refused" },
      });
      expect(response.statusCode).toBe(402);
      expect(response.json()).toEqual({ error: "mpp challenge was not issued by this server" });
    } finally {
      await app.close();
    }
  });
});
