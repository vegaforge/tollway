import {
  type AdapterDriver,
  firstHeaderValue,
  runAdapterConformance,
  webConformanceResponse,
} from "@vegaforge/tollway-server/testing";
import { Hono } from "hono";
import { describe, it } from "vitest";
import { honoPaywall, RECEIPT_CONTEXT_KEY } from "./index.js";

/** Hono driver: `app.request` exercises the real middleware chain. */
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
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers ?? {})) {
          headers.append(name, firstHeaderValue(value));
        }
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
};

runAdapterConformance(driver, { describe, it });
