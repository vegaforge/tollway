import {
  type AdapterDriver,
  type ConformanceResponse,
  runAdapterConformance,
} from "@vegaforge/tollway-server/testing";
import Fastify from "fastify";
import { describe, it } from "vitest";
import { fastifyPaywall, RECEIPT_REQUEST_KEY } from "./index.js";

type InjectedResponse = {
  statusCode: number;
  // Fastify's OutgoingHttpHeaders also permits numeric values.
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
};

function asConformanceResponse(response: InjectedResponse): ConformanceResponse {
  return {
    status: response.statusCode,
    header: (name) => {
      const key = Object.keys(response.headers).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      const value = key === undefined ? undefined : response.headers[key];
      if (value === undefined) return null;
      return Array.isArray(value) ? String(value[0] ?? "") : String(value);
    },
    text: async () => response.body,
  };
}

/** Fastify driver: `inject` keeps the test in-process without a TCP server. */
/** Waits `ms` milliseconds; the two-phase routes use it to run long. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const driver: AdapterDriver = {
  async create({ gate, onPaid }) {
    const app = Fastify();
    app.get("/quotes/latest", { preHandler: fastifyPaywall(gate) }, async (request) => {
      const receipt = request[RECEIPT_REQUEST_KEY];
      if (!receipt) throw new Error("receipt missing on request");
      onPaid(receipt);
      return { ok: true, receiptId: receipt.receipt.id };
    });
    await app.ready();

    return {
      async send(request = {}) {
        // inject passes an array value through as a repeated header.
        const injected = await app.inject({
          method: (request.method ?? "GET") as "GET",
          url: request.path ?? "/quotes/latest",
          headers: request.headers ?? {},
        });
        return asConformanceResponse(injected);
      },
      close: () => app.close(),
    };
  },
  async createAfterHandler({ gate, route }) {
    const app = Fastify();
    app.get(
      "/quotes/latest",
      { preHandler: fastifyPaywall(gate, { settlement: "after-handler" }) },
      async (_request, reply) => {
        if ("throws" in route) throw new Error("route failed");
        await delay(route.delayMs ?? 0);
        return reply.code(route.status).type("text/plain").send(route.body);
      },
    );
    await app.ready();

    return {
      async send(request = {}) {
        const injected = await app.inject({
          method: (request.method ?? "GET") as "GET",
          url: request.path ?? "/quotes/latest",
          headers: request.headers ?? {},
        });
        return asConformanceResponse(injected);
      },
      close: () => app.close(),
    };
  },
};

runAdapterConformance(driver, { describe, it });
