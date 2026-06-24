import { expressPaywall } from "@tollway/adapter-express";
import { Ed25519Signer } from "@tollway/core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  PAYMENT_REQUIRED_HEADER,
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
  const port = Number.parseInt(process.env.PORT ?? "3003", 10);
  const { facilitator, mock } = resolveFacilitator();
  const signer = await Ed25519Signer.generate("content-paywall-example");

  const paywall: PaywallConfig = {
    amount: process.env.CONTENT_PRICE ?? "15000",
    asset:
      process.env.CONTENT_ASSET ??
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    payTo:
      process.env.CONTENT_PAY_TO ??
      "GCONTENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    network: "testnet",
    resource: "/premium",
    models: ["x402"],
  };

  const gate = createPaywall(paywall, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
  });

  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tollway content paywall</title>
  </head>
  <body>
    <main>
      <h1>Tollway content paywall</h1>
      <p>Request <code>/premium</code> without payment to see the x402 challenge.</p>
      <p>Send a <code>PAYMENT-SIGNATURE</code> header in mock mode to unlock the content.</p>
    </main>
  </body>
</html>`);
  });

  app.get("/premium", expressPaywall(gate), (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Premium Tollway Brief</title>
  </head>
  <body>
    <article>
      <h1>Premium Tollway Brief</h1>
      <p>This content was served only after Tollway settled the x402 request.</p>
      <ul>
        <li>Model: x402 per-request payment</li>
        <li>Resource: /premium</li>
        <li>Mode: ${mock ? "mock facilitator" : "real facilitator"}</li>
      </ul>
    </article>
  </body>
</html>`);
  });

  app.get("/challenge-preview", (_req, res) => {
    res.json({
      request: "GET /premium",
      expectedStatus: 402,
      expectedHeader: PAYMENT_REQUIRED_HEADER,
    });
  });

  app.listen(port, () => {
    console.log(`content-paywall example listening on http://127.0.0.1:${port}`);
    console.log(`MOCK_MODE=${mock ? "true" : "false"}`);
  });
}

void main();
