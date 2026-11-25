/**
 * Two-phase settlement through Hono (#152): the route runs before the
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
import { type Handler, Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { honoPaywall, honoRouteTable } from "./index.js";

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
  signer = await Ed25519Signer.generate("two-phase-hono");
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

function makeApp(route: Handler, options: { refuse?: boolean } = {}) {
  const { client, calls } = facilitator(options.refuse);
  const gate = createPaywall(config, {
    signer,
    facilitator: client,
    cache: createInMemorySettlementCache(),
  });
  const app = new Hono();
  app.get("/paid", honoPaywall(gate, { settlement: "after-handler" }), route);
  return { app, calls };
}

const paid = { headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() } };

/** A body streamed in `count` chunks of ten bytes. */
function streamed(count: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode("0123456789");
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
}

describe("honoPaywall with settlement: after-handler", () => {
  it("settles after a successful route and sends its response with the payment headers", async () => {
    const { app, calls } = makeApp((c) => c.json({ quote: 42 }));

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(response.headers.get("tollway-receipt")).toBeTruthy();
    expect(await response.json()).toEqual({ quote: 42 });
    expect(calls.settle).toBe(1);
  });

  it("never settles when the route throws", async () => {
    const { app, calls } = makeApp(() => {
      throw new Error("model overloaded");
    });

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(500);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(response.headers.get("tollway-receipt")).toBeNull();
    expect(calls.settle).toBe(0);
  });

  it("never settles when the route throws under a custom error handler that answers 200", async () => {
    const { app, calls } = makeApp(() => {
      throw new Error("model overloaded");
    });
    app.onError((_error, c) => c.json({ degraded: true }, 200));

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(calls.settle).toBe(0);
  });

  it("never settles when the route answers 500, and passes its response through", async () => {
    const { app, calls } = makeApp((c) => c.json({ error: "upstream down" }, 500));

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(500);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(await response.json()).toEqual({ error: "upstream down" });
    expect(calls.settle).toBe(0);
  });

  it("discards the route's response and answers the rejection when settlement fails", async () => {
    const { app, calls } = makeApp(
      (c) => {
        c.header("x-secret-data", "1");
        return c.json({ quote: 42 });
      },
      { refuse: true },
    );

    const response = await app.request("/paid", paid);

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
    expect(calls.settle).toBe(1);
  });

  it("answers response-too-large and never settles a streamed response over the limit", async () => {
    const { app, calls } = makeApp((c) => c.body(streamed(10)));

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("response-too-large");
    expect(calls.settle).toBe(0);
  });

  it("holds a streamed response under the limit", async () => {
    const { app, calls } = makeApp((c) => {
      c.header("x-route", "yes");
      return c.body(streamed(3), 201);
    });

    const response = await app.request("/paid", paid);

    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("yes");
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.text()).toBe("012345678901234567890123456789");
    expect(calls.settle).toBe(1);
  });

  it("answers 402 without running the route when payment is missing", async () => {
    let ran = false;
    const { app, calls } = makeApp((c) => {
      ran = true;
      return c.json({});
    });

    const response = await app.request("/paid");

    expect(response.status).toBe(402);
    expect(ran).toBe(false);
    expect(calls.settle).toBe(0);
  });

  it("replays a settled payment without settling again", async () => {
    const { app, calls } = makeApp((c) => c.json({ quote: 42 }));

    await app.request("/paid", paid);
    const replay = await app.request("/paid", paid);

    expect(replay.status).toBe(200);
    expect(replay.headers.get("payment-response")).toBeTruthy();
    expect(calls.settle).toBe(1);
  });

  it("refuses a gate that cannot settle after the handler", () => {
    const handWritten: Gate = async () => ({
      kind: "rejected",
      status: 500,
      code: "handler-not-configured",
      reason: "x",
    });

    expect(() => honoPaywall(handWritten, { settlement: "after-handler" })).toThrow(TypeError);
  });

  it("settles after the handler through a route table", async () => {
    const { client, calls } = facilitator();
    const routes = createRouteTable({ "GET /paid/:id": config }, { signer, facilitator: client });
    const app = new Hono();
    app.use(honoRouteTable(routes, { settlement: "after-handler" }));
    app.get("/paid/:id", (c) => c.json({ error: "busy" }, 503));

    const response = await app.request("/paid/1", paid);

    expect(response.status).toBe(503);
    expect(calls.settle).toBe(0);
  });
});
