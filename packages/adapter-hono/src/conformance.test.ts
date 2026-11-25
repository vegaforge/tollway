import {
  type AdapterDriver,
  runAdapterConformance,
  toWebHeaders,
  webConformanceResponse,
} from "@vegaforge/tollway-server/testing";
import { Hono } from "hono";
import { describe, it } from "vitest";
import { honoPaywall, RECEIPT_CONTEXT_KEY } from "./index.js";

/** Hono driver: `app.request` exercises the real middleware chain. */
/** Waits `ms` milliseconds; the two-phase routes use it to run long. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const driver: AdapterDriver = {
  async create({ gate, onPaid }) {
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate), (c) => {
      const receipt = c.get(RECEIPT_CONTEXT_KEY);
      onPaid(receipt);
      return c.json({ ok: true, receiptId: receipt.receipt.id });
    });

    return {
      async send(request = {}) {
        const headers = toWebHeaders(request.headers);
        const response = await app.request(
          `http://example.test${request.path ?? "/quotes/latest"}`,
          {
            method: request.method ?? "GET",
            headers,
          },
        );
        return webConformanceResponse(response);
      },
      close: () => Promise.resolve(),
    };
  },
  async createAfterHandler({ gate, route }) {
    const app = new Hono();
    app.get("/quotes/latest", honoPaywall(gate, { settlement: "after-handler" }), async (c) => {
      if ("throws" in route) throw new Error("route failed");
      await delay(route.delayMs ?? 0);
      return c.text(route.body, route.status as 200);
    });

    return {
      async send(request = {}) {
        const response = await app.request(
          `http://example.test${request.path ?? "/quotes/latest"}`,
          { method: request.method ?? "GET", headers: toWebHeaders(request.headers) },
        );
        return webConformanceResponse(response);
      },
      close: () => Promise.resolve(),
    };
  },
};

runAdapterConformance(driver, { describe, it });
