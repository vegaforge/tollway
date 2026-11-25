/**
 * Two-phase settlement through Fastify (#152): the route runs before the
 * payment settles, and a route that fails is never charged. Every case
 * checks how many times the facilitator's /settle was called.
 */

import { Readable } from "node:stream";
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
import Fastify, { type FastifyInstance, type RouteHandlerMethod } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { fastifyPaywall, fastifyRouteTable } from "./index.js";

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
  signer = await Ed25519Signer.generate("two-phase-fastify");
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

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function serve(route: RouteHandlerMethod, options: { refuse?: boolean } = {}) {
  const { client, calls } = facilitator(options.refuse);
  const gate = createPaywall(config, {
    signer,
    facilitator: client,
    cache: createInMemorySettlementCache(),
  });
  const app = Fastify();
  app.get("/paid", { preHandler: fastifyPaywall(gate, { settlement: "after-handler" }) }, route);
  const base = await listen(app);
  return { url: `${base}/paid`, calls, close: () => app.close() };
}

const paid = { headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() } };

describe("fastifyPaywall with settlement: after-handler", () => {
  it("settles after a successful route and sends its response with the payment headers", async () => {
    const app = await serve(async () => ({ quote: 42 }));
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
    const app = await serve(async () => {
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
    const app = await serve(async (_request, reply) => {
      return reply.code(500).send({ error: "upstream down" });
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
      async (_request, reply) => {
        reply.header("x-secret-data", "1");
        return { quote: 42 };
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
    const app = await serve(async (_request, reply) => {
      const chunks = Array.from({ length: 10 }, () => "0123456789");
      return reply.type("text/plain").send(Readable.from(chunks));
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

  it("holds a streamed response under the limit", async () => {
    const app = await serve(async (_request, reply) => {
      reply.header("x-route", "yes");
      return reply
        .code(201)
        .type("text/plain")
        .send(Readable.from(["part one, ", "part two"]));
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
    const app = await serve(async () => {
      ran = true;
      return {};
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
    const app = await serve(async () => ({ quote: 42 }));
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

    expect(() => fastifyPaywall(handWritten, { settlement: "after-handler" })).toThrow(TypeError);
  });

  it("refuses an unknown settlement option on a route table", () => {
    const routes = createRouteTable({}, { signer, facilitator: createMockFacilitator() });

    expect(() =>
      fastifyRouteTable(routes, { settlement: "later" as unknown as "after-handler" }),
    ).toThrow(TypeError);
  });

  it("settles after the handler through a route table", async () => {
    const { client, calls } = facilitator();
    const routes = createRouteTable({ "GET /paid/:id": config }, { signer, facilitator: client });
    const app = Fastify();
    app.addHook("preHandler", fastifyRouteTable(routes, { settlement: "after-handler" }));
    app.get("/paid/:id", async (_request, reply) => reply.code(503).send({ error: "busy" }));
    const base = await listen(app);
    try {
      const response = await fetch(`${base}/paid/1`, paid);

      expect(response.status).toBe(503);
      expect(calls.settle).toBe(0);
    } finally {
      await app.close();
    }
  });
});
