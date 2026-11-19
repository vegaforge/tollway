import type { Server } from "node:http";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "@vegaforge/tollway-adapter-express";
import { fastifyPaywall } from "@vegaforge/tollway-adapter-fastify";
import { honoPaywall } from "@vegaforge/tollway-adapter-hono";
import { withPaywall } from "@vegaforge/tollway-adapter-next";
import express from "express";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { afterAll, beforeAll, bench, describe } from "vitest";
import {
  BENCH_OPTIONS,
  createBenchGate,
  expectStatus,
  fullInMemoryCache,
  paymentSequence,
  RESOURCE_PATH,
  seedOutcome,
} from "../src/fixtures.js";

/**
 * Each adapter on the challenge path (no payment, 402) and on the settled
 * path (a fresh x402 payment, 200), through the adapter's own entry point.
 * The gate behind each one is the same as in gate.bench.ts, so the
 * difference between these numbers and the gate's is what the framework
 * and the adapter's translation cost.
 */

const BODY = { quote: 42 };

let expressServer: Server;
let expressUrl: string;
let fastifyApp: FastifyInstance;
let honoApp: Hono;
let nextHandler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const seed = await seedOutcome();

  const expressApp = express();
  expressApp.get(
    RESOURCE_PATH,
    expressPaywall(createBenchGate({ cache: await fullInMemoryCache(seed) })),
    (_req, res) => {
      if (!res.locals[RECEIPT_LOCALS_KEY]) throw new Error("express: receipt missing");
      res.json(BODY);
    },
  );
  expressServer = expressApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => expressServer.once("listening", resolve));
  const address = expressServer.address();
  if (!address || typeof address === "string") {
    throw new Error("express: expected a TCP address");
  }
  expressUrl = `http://127.0.0.1:${address.port}${RESOURCE_PATH}`;

  fastifyApp = Fastify();
  fastifyApp.get(
    RESOURCE_PATH,
    { preHandler: fastifyPaywall(createBenchGate({ cache: await fullInMemoryCache(seed) })) },
    async (request) => {
      if (!request.tollwayReceipt) throw new Error("fastify: receipt missing");
      return BODY;
    },
  );
  await fastifyApp.ready();

  honoApp = new Hono();
  honoApp.get(
    RESOURCE_PATH,
    honoPaywall(createBenchGate({ cache: await fullInMemoryCache(seed) })),
    (c) => c.json(BODY),
  );

  nextHandler = withPaywall(createBenchGate({ cache: await fullInMemoryCache(seed) }), () =>
    Response.json(BODY),
  );
});

afterAll(async () => {
  // closeAllConnections drops the client's idle keep-alive socket, which
  // would otherwise hold server.close open until it times out.
  expressServer.closeAllConnections();
  await new Promise((resolve) => expressServer.close(resolve));
  await fastifyApp.close();
});

/**
 * Express is measured over a real loopback socket (`app.listen(0)`), with
 * Node's built-in fetch as the client. That client keeps the connection
 * alive between requests, so a sample is one request and response on an
 * open socket, not a TCP handshake.
 */
describe("adapter: express (listen(0), keep-alive fetch)", () => {
  const nextPayment = paymentSequence("express");

  bench(
    "402 challenge",
    async () => {
      const response = await fetch(expressUrl);
      await response.arrayBuffer();
      expectStatus(response.status, 402, "express");
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 fresh settlement",
    async () => {
      const response = await fetch(expressUrl, {
        headers: { "PAYMENT-SIGNATURE": nextPayment() },
      });
      await response.arrayBuffer();
      expectStatus(response.status, 200, "express");
    },
    BENCH_OPTIONS,
  );
});

describe("adapter: fastify (inject)", () => {
  const nextPayment = paymentSequence("fastify");

  bench(
    "402 challenge",
    async () => {
      const response = await fastifyApp.inject({ method: "GET", url: RESOURCE_PATH });
      expectStatus(response.statusCode, 402, "fastify");
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 fresh settlement",
    async () => {
      const response = await fastifyApp.inject({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { "PAYMENT-SIGNATURE": nextPayment() },
      });
      expectStatus(response.statusCode, 200, "fastify");
    },
    BENCH_OPTIONS,
  );
});

describe("adapter: hono (app.request)", () => {
  const nextPayment = paymentSequence("hono");

  bench(
    "402 challenge",
    async () => {
      const response = await honoApp.request(RESOURCE_PATH);
      await response.arrayBuffer();
      expectStatus(response.status, 402, "hono");
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 fresh settlement",
    async () => {
      const response = await honoApp.request(RESOURCE_PATH, {
        headers: { "PAYMENT-SIGNATURE": nextPayment() },
      });
      await response.arrayBuffer();
      expectStatus(response.status, 200, "hono");
    },
    BENCH_OPTIONS,
  );
});

describe("adapter: next (withPaywall handler)", () => {
  const nextPayment = paymentSequence("next");
  const url = `http://localhost${RESOURCE_PATH}`;

  bench(
    "402 challenge",
    async () => {
      const response = await nextHandler(new Request(url));
      await response.arrayBuffer();
      expectStatus(response.status, 402, "next");
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 fresh settlement",
    async () => {
      const response = await nextHandler(
        new Request(url, { headers: { "PAYMENT-SIGNATURE": nextPayment() } }),
      );
      await response.arrayBuffer();
      expectStatus(response.status, 200, "next");
    },
    BENCH_OPTIONS,
  );
});
