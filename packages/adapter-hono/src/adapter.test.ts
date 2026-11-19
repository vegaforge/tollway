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

// Regression lock for ADR-2026-11-18-method-binding.
describe("honoPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    const app = new Hono();
    app.on(["GET", "POST"], "/report", honoPaywall(gate), (c) => c.json({ ok: true }));
    const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry-method" };

    const read = await app.request("/report", { headers });
    expect(read.status).toBe(200);
    const write = await app.request("/report", { method: "POST", headers });
    expect(write.status).toBe(409);
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

describe("honoPaywall with mpp-charge", () => {
  async function build() {
    const gate = await mppGate();
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate), (c) =>
      c.json({ receiptModel: c.get(RECEIPT_CONTEXT_KEY).receipt.model }),
    );
    return app;
  }

  it("sends the MPP challenge headers with the 402", async () => {
    const response = await (await build()).request("/quotes/latest");
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe('Payment id="test"');
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("settles an Authorization: Payment credential", async () => {
    const response = await (await build()).request("/quotes/latest", {
      headers: { authorization: "Payment ok" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { receiptModel: string }).receiptModel).toBe("mpp-charge");
  });

  it("answers a refused credential with the rejection status", async () => {
    const response = await (await build()).request("/quotes/latest", {
      headers: { authorization: "Payment refused" },
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "mpp challenge was not issued by this server" });
  });
});
