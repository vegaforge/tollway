/**
 * x402 scenario: one per-request x402 payment producing a canonical receipt.
 *
 * The service exposes a paid route; the agent gets a 402, pays with a signed
 * Soroban authorization entry, and verifies the receipt. In mock mode no
 * network calls are made: the mock facilitator settles deterministically.
 *
 * This is the original runDemo behaviour, extracted into the scenario layout.
 * See docs/design.md, "Build plan", Phase 1.
 */

import type { AddressInfo } from "node:net";
import { expressPaywall } from "@vegaforge/tollway-adapter-express";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createPaywall,
  decodeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import express from "express";
import type { ScenarioOptions, X402ScenarioResult } from "./types.js";

/** Price of the demo quote: 0.001 USDC in 7-decimal base units. */
const DEMO_AMOUNT = "10000";

/** Matches the default `maxTimeoutSeconds` in createHttpFacilitator. */
const MAX_TIMEOUT_SECONDS = 60;

/** OpenZeppelin Channels pays the network fee. */
const SPONSORED_FEES = { areFeesSponsored: true };

/**
 * Runs the x402 per-request happy path end to end, verifies the receipt, and
 * returns the result. Throws `DemoConfigError` before any network call if live
 * mode is not configured.
 */
export async function runX402Scenario(options: ScenarioOptions): Promise<X402ScenarioResult> {
  const { facilitator, paywall, payer, mock } = options.setup;
  const signer = await Ed25519Signer.generate("tollway-demo");

  const gate = createPaywall(
    {
      ...paywall,
      amount: DEMO_AMOUNT,
      models: ["x402"],
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: SPONSORED_FEES,
    },
    {
      signer,
      facilitator,
      cache: createInMemorySettlementCache(),
    },
  );

  const app = express();
  app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
    res.json({ symbol: "XLM/USD", price: "0.1234" });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const resource = `http://127.0.0.1:${port}/quotes/latest`;

  try {
    const challenged = await fetch(resource);
    if (challenged.status !== 402) {
      throw new Error(`expected 402, got ${challenged.status}`);
    }
    const challenge = decodePaymentRequiredHeader(
      challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const [requirements] = challenge.accepts;
    if (!requirements) {
      throw new Error("the 402 challenge lists no payment options");
    }

    const payment = await payer(requirements);
    const paid = await fetch(resource, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payment) },
    });
    if (paid.status !== 200) {
      throw new Error(`expected 200 after payment, got ${paid.status}: ${await paid.text()}`);
    }
    const settlement = decodePaymentResponseHeader(paid.headers.get(PAYMENT_RESPONSE_HEADER) ?? "");
    if (!settlement.success) {
      throw new Error(`the settlement did not succeed: ${settlement.errorReason ?? "no reason"}`);
    }
    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
    const verification = await verifyReceipt(receipt, Ed25519Verifier.forSigner(signer));

    return {
      scenario: "x402",
      mock,
      resource,
      amount: requirements.amount,
      asset: requirements.asset,
      settlement:
        receipt.receipt.settlement.kind === "transaction"
          ? receipt.receipt.settlement.txHash
          : undefined,
      receipt,
      receiptValid: verification.valid,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
