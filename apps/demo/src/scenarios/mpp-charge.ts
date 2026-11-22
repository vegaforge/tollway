/**
 * MPP charge scenario: one per-request MPP charge payment producing a
 * canonical receipt.
 *
 * MPP charge uses the same route as x402 but changes the paywall model to
 * "mpp-charge". The agent sends an `Authorization: Payment <credential>`
 * header instead of `PAYMENT-SIGNATURE`. In mock mode the offline handler
 * settles deterministically; live mode requires #100 and is out of scope here.
 *
 * This demonstrates the Phase 1 exit from docs/design.md: "the same route
 * serves both x402 and MPP charge with a config flag".
 *
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
  createMockMppChargeHandler,
  createPaywall,
  decodeHeader,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import express from "express";
import type { MppChargeScenarioResult, ScenarioOptions } from "./types.js";

/** Price of the demo quote: 0.001 USDC in 7-decimal base units. */
const DEMO_AMOUNT = "10000";

/**
 * Runs the MPP charge per-request happy path end to end, verifies the receipt,
 * and returns the result.
 *
 * Live mode for MPP charge is out of scope until #100 lands. Calling this
 * function outside of mock mode will throw, as the mock handler is the only
 * one available.
 */
export async function runMppChargeScenario(
  options: ScenarioOptions,
): Promise<MppChargeScenarioResult> {
  const { paywall, mock } = options.setup;

  if (!mock) {
    throw new Error(
      "MPP charge live mode is not supported yet (tracked in #100). Run with MOCK_MODE=true.",
    );
  }

  const signer = await Ed25519Signer.generate("tollway-demo-mpp-charge");
  const handler = createMockMppChargeHandler();

  const gate = createPaywall(
    {
      ...paywall,
      amount: DEMO_AMOUNT,
      models: ["mpp-charge"],
    },
    {
      signer,
      facilitator: options.setup.facilitator,
      mppChargeHandler: handler,
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
    // First call: no credential, should get 402.
    const challenged = await fetch(resource);
    if (challenged.status !== 402) {
      throw new Error(`expected 402, got ${challenged.status}`);
    }

    // Second call: send the MPP charge credential in Authorization: Payment.
    // The mock handler accepts any non-empty payload; use a stable string.
    const credential = "Payment mpp-charge-demo-payload";
    const paid = await fetch(resource, {
      headers: { Authorization: credential },
    });
    if (paid.status !== 200) {
      throw new Error(
        `expected 200 after MPP charge payment, got ${paid.status}: ${await paid.text()}`,
      );
    }

    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
    if (receipt.receipt.model !== "mpp-charge") {
      throw new Error(`expected model mpp-charge, got "${receipt.receipt.model}"`);
    }

    const verification = await verifyReceipt(receipt, Ed25519Verifier.forSigner(signer));

    const settlement = receipt.receipt.settlement;
    const txHash = settlement.kind === "transaction" ? settlement.txHash : undefined;

    return {
      scenario: "mpp-charge",
      mock,
      resource,
      amount: receipt.receipt.amount,
      asset: receipt.receipt.asset,
      settlement: txHash,
      receipt,
      receiptValid: verification.valid,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
