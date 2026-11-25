import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  type AdapterDriver,
  type ConformanceRequest,
  type ConformanceResponse,
  runAdapterConformance,
} from "@vegaforge/tollway-server/testing";
import express from "express";
import { describe, it } from "vitest";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "./index.js";

/**
 * Sends one request with `node:http`. Unlike `fetch`, it writes a header
 * given as an array as one line per value, so a repeated header reaches
 * Express as it would from a real client.
 */
function send(port: number, request: ConformanceRequest): Promise<ConformanceResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: request.method ?? "GET",
        path: request.path ?? "/quotes/latest",
        headers: request.headers ?? {},
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode ?? 0,
            header: (name) => {
              const value = incoming.headers[name.toLowerCase()];
              if (value === undefined) return null;
              return Array.isArray(value) ? value.join(", ") : value;
            },
            text: async () => body,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** Waits `ms` milliseconds; the two-phase routes use it to run long. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Express driver: a real HTTP server on an ephemeral port, as #107 asks. */
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
    const { port } = server.address() as AddressInfo;

    return {
      send: (request = {}) => send(port, request),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  },
  async createAfterHandler({ gate, route }) {
    const app = express();
    app.get(
      "/quotes/latest",
      expressPaywall(gate, { settlement: "after-handler" }),
      async (_req, res) => {
        if ("throws" in route) throw new Error("route failed");
        await delay(route.delayMs ?? 0);
        res.status(route.status).type("text/plain").send(route.body);
      },
    );

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    return {
      send: (request = {}) => send(port, request),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  },
};

runAdapterConformance(driver, { describe, it });
