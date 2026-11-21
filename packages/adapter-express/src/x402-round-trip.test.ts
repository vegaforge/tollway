import {
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createMockFacilitator,
  createPaywall,
  decodeHeader,
  type FacilitatorClient,
  PAYMENT_RESPONSE_HEADER,
  type PaywallConfig,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, SchemeNetworkClient } from "@x402/core/types";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { expressPaywall } from "./index.js";

/**
 * The issue #43 acceptance test: a client built from @x402/core's own
 * client-side helpers reads a Tollway gate's 402 challenge, pays it, and reads
 * the SettleResponse and the Tollway receipt. The facilitator is stubbed, so
 * no Stellar RPC is involved.
 */
const config = {
  amount: "10000",
  // USDC testnet SAC: the Soroban contract address x402 names as the asset.
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  extra: { areFeesSponsored: true },
} satisfies PaywallConfig;

const RESOURCE = "/quotes/latest";
const TRANSACTION = "AAAAAgAAAAB4NDAyLXN0ZWxsYXItdHJhbnNhY3Rpb24=";

async function startGate() {
  const signer = await Ed25519Signer.generate("x402-round-trip");
  const inner = createMockFacilitator();
  const verify = vi.fn(inner.verify.bind(inner));
  const facilitator: FacilitatorClient = { ...inner, verify };

  const app = express();
  app.get(RESOURCE, expressPaywall(createPaywall(config, { signer, facilitator })), (_req, res) => {
    res.json({ symbol: "XLM/USD", price: "0.1234" });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}${RESOURCE}`,
    signer,
    verify,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("x402 V2 client round trip through expressPaywall", () => {
  it("reads the challenge, pays it, and reads the settlement and receipt", async () => {
    const gate = await startGate();
    const http = new x402HTTPClient(new x402Client());

    try {
      const unpaid = await fetch(gate.url);
      expect(unpaid.status).toBe(402);

      const challenge = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name));
      expect(challenge.x402Version).toBe(2);
      // The offer's resource is the request path, as the gate reports it.
      expect(challenge.resource.url).toBe(RESOURCE);
      expect(challenge.accepts).toEqual([
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: config.asset,
          amount: config.amount,
          payTo: config.payTo,
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ]);
      // The JSON body carries the same PaymentRequired as the header.
      expect(await unpaid.json()).toEqual(challenge);

      const [requirements] = challenge.accepts;
      if (!requirements) throw new Error("expected a payment option");
      const payment: PaymentPayload = {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: TRANSACTION },
      };

      const paid = await fetch(gate.url, {
        headers: http.encodePaymentSignatureHeader(payment),
      });
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ symbol: "XLM/USD", price: "0.1234" });

      // The HTTP facilitator received the decoded V2 payload unchanged.
      expect(gate.verify).toHaveBeenCalledWith(
        expect.objectContaining({ payment: { model: "x402", payload: payment } }),
      );

      const settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));
      expect(settlement).toMatchObject({ success: true, network: "stellar:testnet" });

      const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
      expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy();
      expect(receipt.receipt).toMatchObject({ model: "x402", amount: config.amount });
      expect(settlement.transaction).toBe(
        receipt.receipt.settlement.kind === "transaction"
          ? receipt.receipt.settlement.txHash
          : undefined,
      );
      expect(await verifyReceipt(receipt, Ed25519Verifier.forSigner(gate.signer))).toMatchObject({
        valid: true,
      });
    } finally {
      await gate.close();
    }
  });
});

/**
 * Issue #293: a stock x402 client pays a dynamic-price route. The client's
 * own `createPaymentPayload` builds `accepted` from the 402, so this proves
 * the quote in `extra` comes back unchanged without any Tollway code on the
 * client. The scheme client is a stub that only supplies the transaction.
 */
describe("x402 V2 client round trip through a dynamic-price route", () => {
  const stubStellarScheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(x402Version) {
      return { x402Version, payload: { transaction: TRANSACTION } };
    },
  };

  it("pays the quoted amount with the quote echoed by the client", async () => {
    const signer = await Ed25519Signer.generate("x402-dynamic-round-trip");
    let calls = 0;
    const gate = createPaywall(
      {
        ...config,
        amount: () => String(10_000 + ++calls),
        minAmount: "1",
        maxAmount: "1000000",
        quoteSecret: "round trip quote secret",
      },
      { signer, facilitator: createMockFacilitator() },
    );
    const app = express();
    app.get(RESOURCE, expressPaywall(gate), (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}${RESOURCE}`;

    try {
      // The stub scheme has no default-asset table, so the client treats USDC as
      // a non-default asset; the test lists it with a cap, as an agent would.
      const client = new x402Client()
        .register("stellar:testnet", stubStellarScheme)
        .setSpendControls({
          allowedAssets: [
            { network: "stellar:testnet", asset: config.asset, maxAmountPerPayment: "1000000" },
          ],
        });
      const http = new x402HTTPClient(client);

      const unpaid = await fetch(url);
      expect(unpaid.status).toBe(402);
      const challenge = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name));
      const quote = challenge.accepts[0]?.extra.tollwayQuote;
      expect(quote).toEqual(expect.any(String));

      const payment = await client.createPaymentPayload(challenge);
      expect(payment.accepted.extra.tollwayQuote).toBe(quote);

      const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payment) });
      expect(paid.status).toBe(200);
      const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
      expect(receipt.receipt.amount).toBe("10001");
      // The price function ran once, for the 402; the paid request used the quote.
      expect(calls).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
