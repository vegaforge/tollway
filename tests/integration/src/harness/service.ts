import { createServer } from "node:http";
import { expressPaywall } from "@vegaforge/tollway-adapter-express";
import type { PaymentOffer } from "@vegaforge/tollway-core";
import type { Gate, GateOutcome } from "@vegaforge/tollway-server";
import { createEd25519Signer, ExactStellarScheme, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import express from "express";
import { listen } from "./tls-proxy.js";

/**
 * Seconds a payment stays valid. The x402 client signs against it and the
 * facilitator checks the same value, so both sides are configured from here.
 */
export const MAX_TIMEOUT_SECONDS = 60;

/**
 * The fee sponsorship flag the `@x402/stellar` exact scheme requires on
 * both sides: the client refuses to build a payment without it.
 */
export const SPONSORED_FEES = { areFeesSponsored: true };

export const PAID_PATH = "/paid/quote";

export type PaidService = {
  url: string;
  /** Every outcome the gate returned, in order, so tests can assert `replayed` and `rejected`. */
  outcomes: GateOutcome[];
  close(): Promise<void>;
};

/** An Express app with one route behind `expressPaywall`, on a random port. */
export async function startPaidService(gate: Gate): Promise<PaidService> {
  const outcomes: GateOutcome[] = [];
  const recordingGate: Gate = async (request) => {
    const outcome = await gate(request);
    outcomes.push(outcome);
    return outcome;
  };
  const app = express();
  app.get(PAID_PATH, expressPaywall(recordingGate), (_request, response) => {
    response.json({ symbol: "XLM/USD", price: "0.1234" });
  });
  const listening = await listen(createServer(app), "http");
  return { url: `${listening.url}${PAID_PATH}`, outcomes, close: listening.close };
}

/**
 * Signs an x402 payment for an offer, the way `createStellarPayer` in
 * apps/demo/src/demo.ts does: `@x402/stellar`'s client scheme builds and
 * signs a SEP-41 transfer and returns the base64 transaction that goes in
 * PAYMENT-SIGNATURE. `amount` overrides the offer's amount to build a
 * payment for the wrong price.
 */
export function createX402Payer(options: { secret: string; rpcUrl: string }) {
  const signer = createEd25519Signer(options.secret, STELLAR_TESTNET_CAIP2);
  const scheme = new ExactStellarScheme(signer, { url: options.rpcUrl });
  return async (offer: PaymentOffer, overrides: { amount?: string } = {}): Promise<string> => {
    if (offer.network !== "testnet") {
      throw new Error(`the local suite only pays testnet offers, got "${offer.network}"`);
    }
    const { payload } = await scheme.createPaymentPayload(2, {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2,
      asset: offer.asset,
      amount: overrides.amount ?? offer.amount,
      payTo: offer.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: SPONSORED_FEES,
    });
    if (typeof payload.transaction !== "string") {
      throw new Error("@x402/stellar returned a payment payload without a transaction");
    }
    return payload.transaction;
  };
}
