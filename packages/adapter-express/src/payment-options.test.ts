import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  type FacilitatorClient,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@vegaforge/tollway-server";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "./index.js";

/** Issue #158 through an adapter: a two-option route, paid with option 2. */

const PAYEE = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

function spied(): { client: FacilitatorClient; settle: ReturnType<typeof vi.fn> } {
  const inner = createMockFacilitator();
  const settle = vi.fn(inner.settle.bind(inner));
  return { client: { ...inner, settle }, settle };
}

describe("expressPaywall with two payment options", () => {
  it("lists both options and settles the one the payer chose", async () => {
    const signer = await Ed25519Signer.generate("express-options");
    const mainnet = spied();
    const testnet = spied();
    const gate = createPaywall(
      {
        accepts: [
          {
            amount: "10000",
            asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
            payTo: PAYEE,
            network: "mainnet",
            facilitator: mainnet.client,
          },
          {
            amount: "20000",
            asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            payTo: PAYEE,
            network: "testnet",
            facilitator: testnet.client,
          },
        ],
      },
      { signer, cache: createInMemorySettlementCache() },
    );
    const app = express();
    app.get("/paid", expressPaywall(gate), (_req, res) => {
      res.json({ network: res.locals[RECEIPT_LOCALS_KEY].receipt.network });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a TCP address");
      const url = `http://127.0.0.1:${address.port}/paid`;

      const unpaid = await fetch(url);
      expect(unpaid.status).toBe(402);
      const { accepts } = decodePaymentRequiredHeader(
        unpaid.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
      );
      expect(accepts.map((option) => option.network)).toEqual([
        "stellar:pubnet",
        "stellar:testnet",
      ]);

      const paid = await fetch(url, {
        headers: {
          [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: accepts[1] as (typeof accepts)[number],
            payload: { transaction: "mock-envelope" },
          }),
        },
      });
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ network: "testnet" });
      expect(testnet.settle).toHaveBeenCalledTimes(1);
      expect(mainnet.settle).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
