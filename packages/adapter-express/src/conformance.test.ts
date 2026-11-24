import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  type AdapterDriver,
  firstHeaderValue,
  runAdapterConformance,
  webConformanceResponse,
} from "@vegaforge/tollway-server/testing";
import express from "express";
import { describe, it } from "vitest";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "./index.js";

/** Express driver: a real HTTP server, as the issue asks for this adapter. */
const driver: AdapterDriver = {
  async create({ gate, onPaid }) {
    const app = express();
    app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
      const receipt = res.locals[RECEIPT_LOCALS_KEY] as SignedReceipt;
      onPaid(receipt);
      res.json({ ok: true, receiptId: receipt.receipt.id });
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    return {
      async send(request = {}) {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers ?? {})) {
          headers.append(name, firstHeaderValue(value));
        }
        const response = await fetch(`${base}${request.path ?? "/quotes/latest"}`, {
          method: request.method ?? "GET",
          headers,
        });
        return webConformanceResponse(response);
      },
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  },
};

runAdapterConformance(driver, { describe, it });
