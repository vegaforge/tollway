/**
 * Payment options scenario (#158): one route offers two ways to pay, USDC on
 * mainnet and USDC on testnet, each settled by its own facilitator. The agent
 * reads both from a single 402, picks the second, and the receipt names the
 * option it paid. Mock mode only: a live run would need funded payers on both
 * networks.
 */

import type { AddressInfo } from "node:net";
import { expressPaywall } from "@vegaforge/tollway-adapter-express";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type ReceiptVerifier,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  decodeHeader,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import express from "express";
import type { ScenarioResult } from "./types.js";

const PAYEE = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

/** Mainnet first: the service prefers it, and the agent may still choose testnet. */
const PAYMENT_OPTIONS: PaywallConfig = {
  accepts: [
    {
      amount: "10000",
      asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      payTo: PAYEE,
      network: "mainnet",
      facilitator: createMockFacilitator(),
    },
    {
      amount: "20000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: PAYEE,
      network: "testnet",
      facilitator: createMockFacilitator(),
    },
  ],
  models: ["x402"],
};

/** Runs the two-option route end to end in mock mode, paying with option 2. */
export async function runPaymentOptionsScenario(): Promise<
  ScenarioResult & { verifier: ReceiptVerifier; offered: string[] }
> {
  const signer = await Ed25519Signer.generate("tollway-demo-payment-options");
  const gate = createPaywall(PAYMENT_OPTIONS, { signer, cache: createInMemorySettlementCache() });

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
    if (challenged.status !== 402) throw new Error(`expected 402, got ${challenged.status}`);
    const { accepts } = decodePaymentRequiredHeader(
      challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const chosen = accepts[1];
    if (accepts.length !== 2 || !chosen) {
      throw new Error(`expected two payment options, got ${accepts.length}`);
    }

    const paid = await fetch(resource, {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: chosen,
          payload: { transaction: "payment-options-demo-envelope" },
        }),
      },
    });
    if (paid.status !== 200) {
      throw new Error(`expected 200 after payment, got ${paid.status}: ${await paid.text()}`);
    }
    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(TOLLWAY_RECEIPT_HEADER) ?? "");
    if (receipt.receipt.network !== "testnet" || receipt.receipt.amount !== chosen.amount) {
      throw new Error("the receipt does not name the option the agent paid");
    }
    const verifier = Ed25519Verifier.forSigner(signer);
    const verification = await verifyReceipt(receipt, verifier);
    const settlement = receipt.receipt.settlement;
    return {
      scenario: "payment-options",
      mock: true,
      resource: new URL(resource).pathname,
      amount: receipt.receipt.amount,
      asset: receipt.receipt.asset,
      settlement: settlement.kind === "transaction" ? settlement.txHash : undefined,
      receipt,
      receiptValid: verification.valid,
      verifier,
      offered: accepts.map((option) => `${option.network} ${option.amount}`),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
