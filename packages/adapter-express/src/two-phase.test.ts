/**
 * Two-phase settlement through Express (#152): the route runs before the
 * payment settles, and a route that fails is never charged. Every case
 * checks how many times the facilitator's /settle was called.
 */

import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  createRouteTable,
  encodePaymentSignatureHeader,
  type FacilitatorClient,
  type Gate,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import express, { type RequestHandler } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { expressPaywall, expressRouteTable } from "./index.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
  twoPhase: { maxResponseBytes: 64 },
} satisfies PaywallConfig;

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

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("two-phase-express");
});

function facilitator(refuse = false) {
  const inner = createMockFacilitator();
  const calls = { settle: 0 };
  const client: FacilitatorClient = {
    ...inner,
    async settle(input) {
      calls.settle += 1;
      return refuse ? { settled: false, reason: "tx failed" } : inner.settle(input);
    },
  };
  return { client, calls };
}

async function serve(route: RequestHandler, options: { refuse?: boolean } = {}) {
  const { client, calls } = facilitator(options.refuse);
  const gate = createPaywall(config, {
    signer,
    facilitator: client,
    cache: createInMemorySettlementCache(),
  });
  const app = express();
  app.get("/paid", expressPaywall(gate, { settlement: "after-handler" }), route);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/paid`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const paid = { headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() } };

describe("expressPaywall with settlement: after-handler", () => {
  it("settles after a successful route and sends its response with the payment headers", async () => {
    const app = await serve((_req, res) => {
      res.json({ quote: 42 });
    });
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(200);
      expect(response.headers.get("payment-response")).toBeTruthy();
      expect(response.headers.get("tollway-receipt")).toBeTruthy();
      expect(await response.json()).toEqual({ quote: 42 });
      expect(app.calls.settle).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("never settles when the route throws", async () => {
    const app = await serve(() => {
      throw new Error("model overloaded");
    });
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(500);
      expect(response.headers.get("payment-response")).toBeNull();
      expect(response.headers.get("tollway-receipt")).toBeNull();
      expect(app.calls.settle).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("never settles when the route answers 500, and passes its response through", async () => {
    const app = await serve((_req, res) => {
      res.status(500).json({ error: "upstream down" });
    });
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(500);
      expect(response.headers.get("payment-response")).toBeNull();
      expect(await response.json()).toEqual({ error: "upstream down" });
      expect(app.calls.settle).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("discards the route's response and answers the rejection when settlement fails", async () => {
    const app = await serve(
      (_req, res) => {
        res.setHeader("x-secret-data", "1");
        res.json({ quote: 42 });
      },
      { refuse: true },
    );
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "settlement-failed",
          message: "the facilitator refused to settle the payment",
          upstreamReason: "tx failed",
        },
      });
      expect(response.headers.get("x-secret-data")).toBeNull();
      expect(response.headers.get("payment-response")).toBeNull();
      expect(app.calls.settle).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("answers response-too-large and never settles a streamed response over the limit", async () => {
    const app = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let chunk = 0; chunk < 10; chunk += 1) res.write("0123456789");
      res.end();
    });
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("response-too-large");
      expect(app.calls.settle).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("holds a streamed response under the limit, headers set by writeHead included", async () => {
    const app = await serve((_req, res) => {
      res.writeHead(201, { "content-type": "text/plain", "x-route": "yes" });
      res.write("part one, ");
      res.end("part two");
    });
    try {
      const response = await fetch(app.url, paid);

      expect(response.status).toBe(201);
      expect(response.headers.get("x-route")).toBe("yes");
      expect(response.headers.get("payment-response")).toBeTruthy();
      expect(await response.text()).toBe("part one, part two");
      expect(app.calls.settle).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("answers 402 without running the route when payment is missing", async () => {
    let ran = false;
    const app = await serve((_req, res) => {
      ran = true;
      res.json({});
    });
    try {
      const response = await fetch(app.url);

      expect(response.status).toBe(402);
      expect(ran).toBe(false);
      expect(app.calls.settle).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("replays a settled payment without settling again", async () => {
    const app = await serve((_req, res) => {
      res.json({ quote: 42 });
    });
    try {
      await fetch(app.url, paid);
      const replay = await fetch(app.url, paid);

      expect(replay.status).toBe(200);
      expect(replay.headers.get("payment-response")).toBeTruthy();
      expect(app.calls.settle).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a gate that cannot settle after the handler", () => {
    const handWritten: Gate = async () => ({
      kind: "rejected",
      status: 500,
      code: "handler-not-configured",
      reason: "x",
    });

    expect(() => expressPaywall(handWritten, { settlement: "after-handler" })).toThrow(TypeError);
  });

  it("refuses an unknown settlement option", () => {
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

    expect(() =>
      expressPaywall(gate, { settlement: "later" as unknown as "after-handler" }),
    ).toThrow(TypeError);
  });

  it("settles after the handler through a route table", async () => {
    const { client, calls } = facilitator();
    const routes = createRouteTable({ "GET /paid/:id": config }, { signer, facilitator: client });
    const app = express();
    app.use(expressRouteTable(routes, { settlement: "after-handler" }));
    app.get("/paid/:id", (_req, res) => {
      res.status(503).json({ error: "busy" });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/paid/1`, paid);

      expect(response.status).toBe(503);
      expect(calls.settle).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
