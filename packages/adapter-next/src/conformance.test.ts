import {
  type AdapterDriver,
  runAdapterConformance,
  toWebHeaders,
  webConformanceResponse,
} from "@vegaforge/tollway-server/testing";
import { describe, it } from "vitest";
import { withPaywall } from "./index.js";

/** Next driver: call the wrapped App Router handler with a Web `Request`. */
const driver: AdapterDriver = {
  async create({ gate, onPaid }) {
    const handler = withPaywall(gate, async (_request, { receipt }) => {
      onPaid(receipt);
      return Response.json({ ok: true, receiptId: receipt.receipt.id });
    });

    return {
      async send(request = {}) {
        const headers = toWebHeaders(request.headers);
        const response = await handler(
          new Request(`http://example.test${request.path ?? "/quotes/latest"}`, {
            method: request.method ?? "GET",
            headers,
          }),
        );
        return webConformanceResponse(response);
      },
      close: () => Promise.resolve(),
    };
  },
};

runAdapterConformance(driver, { describe, it });
