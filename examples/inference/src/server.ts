import { expressPaywall, RECEIPT_LOCALS_KEY } from "@tollway/adapter-express";
import { Ed25519Signer, type SignedReceipt } from "@tollway/core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  type FacilitatorClient,
  type PaywallConfig,
} from "@tollway/server";
import express from "express";

const DEFAULT_FACILITATOR_URL = "https://channels.openzeppelin.com/x402";

function resolveFacilitator(): { facilitator: FacilitatorClient; mock: boolean } {
  if (process.env.MOCK_MODE === "true") {
    return { facilitator: createMockFacilitator(), mock: true };
  }

  return {
    facilitator: createHttpFacilitator(process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL),
    mock: false,
  };
}

function getReceipt(locals: Record<string, unknown>): SignedReceipt {
  const receipt = locals[RECEIPT_LOCALS_KEY];
  if (!receipt) {
    throw new Error("expected Tollway receipt in res.locals");
  }
  return receipt as SignedReceipt;
}

async function main(): Promise<void> {
  const app = express();
  const port = Number.parseInt(process.env.PORT ?? "3002", 10);
  const { facilitator, mock } = resolveFacilitator();
  const signer = await Ed25519Signer.generate("inference-example");

  const paywall: PaywallConfig = {
    amount: process.env.INFERENCE_PRICE ?? "50000",
    asset:
      process.env.INFERENCE_ASSET ??
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    payTo:
      process.env.INFERENCE_PAY_TO ??
      "GINFERENCEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    network: "testnet",
    resource: "/complete",
    models: ["x402"],
  };

  const gate = createPaywall(paywall, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
  });

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mock });
  });

  app.post("/complete", expressPaywall(gate), (req, res) => {
    const receipt = getReceipt(res.locals);
    const prompt =
      typeof req.body?.prompt === "string" && req.body.prompt.trim().length > 0
        ? req.body.prompt.trim()
        : "Summarize the latest Stellar agent-payment news";

    res.json({
      model: "tollway-demo-canned",
      prompt,
      completion:
        "Tollway routes this paid inference request through x402, settles it, and exposes a signed receipt to the handler.",
      receipt: {
        model: receipt.receipt.model,
        resource: receipt.receipt.resource,
        amount: receipt.receipt.amount,
        asset: receipt.receipt.asset,
        payer: receipt.receipt.payer,
        payee: receipt.receipt.payee,
        txHash:
          receipt.receipt.settlement.kind === "transaction"
            ? receipt.receipt.settlement.txHash
            : undefined,
      },
    });
  });

  app.listen(port, () => {
    console.log(`inference example listening on http://127.0.0.1:${port}`);
    console.log(`MOCK_MODE=${mock ? "true" : "false"}`);
  });
}

void main();
