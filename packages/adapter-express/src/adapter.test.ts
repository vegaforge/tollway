import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createMockMppChargeHandler,
  createPaywall,
  createRouteTable,
  encodePaymentSignatureHeader,
  type MppChargeHandler,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import express from "express";
import { describe, expect, it } from "vitest";
import { expressPaywall, expressRouteTable, RECEIPT_LOCALS_KEY } from "./index.js";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
};

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(transaction = "mock-signed-auth-entry"): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  });
}

async function startApp() {
  const signer = await Ed25519Signer.generate("test-key");
  const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

  const app = express();
  app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
    res.json({ quote: 42, receiptId: res.locals[RECEIPT_LOCALS_KEY].receipt.id });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/quotes/latest`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("expressPaywall", () => {
  it("answers 402 with a challenge when payment is missing", async () => {
    const app = await startApp();
    try {
      const response = await fetch(app.url);
      expect(response.status).toBe(402);
      const challenge = (await response.json()) as { accepts: Array<{ amount: string }> };
      expect(challenge.accepts[0]?.amount).toBe("10000");
    } finally {
      await app.close();
    }
  });

  it("serves the resource once a valid payment is supplied", async () => {
    const app = await startApp();
    try {
      const response = await fetch(app.url, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("payment-response")).toBeTruthy();
      const body = (await response.json()) as { quote: number; receiptId: string };
      expect(body.quote).toBe(42);
      expect(body.receiptId).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

describe("expressRouteTable", () => {
  it("gates paid paths and passes free paths through", async () => {
    const signer = await Ed25519Signer.generate("route-table-express");
    const routes = createRouteTable(
      { "GET /paid/:id": config },
      { signer, facilitator: createMockFacilitator() },
    );
    const app = express();
    app.use(expressRouteTable(routes));
    app.get("/paid/:id", (_req, res) => res.send("paid"));
    app.get("/free", (_req, res) => res.send("free"));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/paid/1`)).status).toBe(402);
      expect(await (await fetch(`http://127.0.0.1:${address.port}/free`)).text()).toBe("free");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("expressPaywall with a shared settlement cache", () => {
  it("does not serve a second route for a payment made on the first", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });

    const served: string[] = [];
    const app = express();
    app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
      served.push("latest");
      res.json({ quote: 42 });
    });
    app.get("/quotes/history", expressPaywall(gate), (_req, res) => {
      served.push("history");
      res.json({ quotes: [40, 41, 42] });
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

      const paid = await fetch(`${base}/quotes/latest`, { headers });
      expect(paid.status).toBe(200);

      const replay = await fetch(`${base}/quotes/history`, { headers });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({
        error: "payment already settled for a different offer",
      });
      expect(served).toEqual(["latest"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// Regression lock for ADR-2026-11-18-method-binding.
describe("expressPaywall method binding", () => {
  it("does not let a payment made for GET unlock POST on the same path", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createInMemorySettlementCache(),
    });
    const app = express();
    app.all("/report", expressPaywall(gate), (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}/report`;
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };
    try {
      const read = await fetch(url, { headers });
      expect(read.status).toBe(200);
      const write = await fetch(url, { method: "POST", headers });
      expect(write.status).toBe(409);
    } finally {
      await new Promise((resolve) => server.close(resolve));
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

describe("expressPaywall with mpp-charge", () => {
  async function start() {
    const gate = await mppGate();
    const app = express();
    app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
      res.json({ receiptModel: res.locals[RECEIPT_LOCALS_KEY].receipt.model });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    return {
      url: `http://127.0.0.1:${address.port}/quotes/latest`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("sends the MPP challenge headers with the 402", async () => {
    const app = await start();
    try {
      const response = await fetch(app.url);
      expect(response.status).toBe(402);
      expect(response.headers.get("www-authenticate")).toBe('Payment id="test"');
      expect(response.headers.get("payment-required")).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("settles an Authorization: Payment credential", async () => {
    const app = await start();
    try {
      const response = await fetch(app.url, { headers: { authorization: "Payment ok" } });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { receiptModel: string }).receiptModel).toBe("mpp-charge");
    } finally {
      await app.close();
    }
  });

  it("answers a refused credential with the rejection status", async () => {
    const app = await start();
    try {
      const response = await fetch(app.url, { headers: { authorization: "Payment refused" } });
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({
        error: "mpp challenge was not issued by this server",
      });
    } finally {
      await app.close();
    }
  });
});
