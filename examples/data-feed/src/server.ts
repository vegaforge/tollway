import { expressPaywall } from "@tollway/adapter-express";
import { Ed25519Signer } from "@tollway/core";
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

async function main(): Promise<void> {
  const app = express();
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const { facilitator, mock } = resolveFacilitator();
  const signer = await Ed25519Signer.generate("data-feed-example");

  const paywall: PaywallConfig = {
    amount: process.env.FEED_PRICE ?? "25000",
    asset:
      process.env.FEED_ASSET ??
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    payTo:
      process.env.FEED_PAY_TO ?? "GDATAFEEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    network: "testnet",
    resource: "/feed",
    models: ["x402"],
  };

  const gate = createPaywall(paywall, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mock });
  });

  app.get("/feed", expressPaywall(gate), (_req, res) => {
    res.json({
      feed: "xlm-usdc-midpoint",
      asOf: new Date().toISOString(),
      rows: [
        { symbol: "XLM/USDC", bid: "0.1230", ask: "0.1236" },
        { symbol: "XLM/EURC", bid: "0.1132", ask: "0.1139" },
      ],
    });
  });

  app.listen(port, () => {
    console.log(`data-feed example listening on http://127.0.0.1:${port}`);
    console.log(`MOCK_MODE=${mock ? "true" : "false"}`);
  });
}

void main();
