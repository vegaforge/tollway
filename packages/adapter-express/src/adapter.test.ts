import { Ed25519Signer } from "@tollway/core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@tollway/server";
import express from "express";
import { describe, expect, it } from "vitest";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "./index.js";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
};

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
      const challenge = (await response.json()) as { amount: string };
      expect(challenge.amount).toBe("10000");
    } finally {
      await app.close();
    }
  });

  it("serves the resource once a valid payment is supplied", async () => {
    const app = await startApp();
    try {
      const response = await fetch(app.url, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
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
      const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" };

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
