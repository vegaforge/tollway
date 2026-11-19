import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  createRouteTable,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { honoPaywall, honoRouteTable, RECEIPT_CONTEXT_KEY } from "./index.js";

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

describe("honoRouteTable", () => {
  it("gates paid paths and passes free paths through", async () => {
    const signer = await Ed25519Signer.generate("route-table-hono");
    const routes = createRouteTable(
      { "GET /paid/:id": config },
      { signer, facilitator: createMockFacilitator() },
    );
    const app = new Hono();
    app.use("*", honoRouteTable(routes));
    app.get("/paid/:id", (c) => c.text("paid"));
    app.get("/free", (c) => c.text("free"));
    expect((await app.request("/paid/1")).status).toBe(402);
    expect(await (await app.request("/free")).text()).toBe("free");
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
