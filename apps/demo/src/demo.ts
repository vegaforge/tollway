import type { AddressInfo } from "node:net";
import { expressPaywall } from "@tollway/adapter-express";
import { Ed25519Signer, Ed25519Verifier, type SignedReceipt, verifyReceipt } from "@tollway/core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  decodeHeader,
  type FacilitatorClient,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaywallConfig,
} from "@tollway/server";
import express from "express";

/** Default to the OpenZeppelin Stellar facilitator from docs/design.md. */
const DEFAULT_FACILITATOR_URL = "https://channels.openzeppelin.com/x402";

export type DemoResult = {
  mock: boolean;
  challenge: { amount: string; asset: string; resource: string };
  receipt: SignedReceipt;
  receiptValid: boolean;
};

function resolveFacilitator(): { facilitator: FacilitatorClient; mock: boolean } {
  if (process.env.MOCK_MODE === "true") {
    return { facilitator: createMockFacilitator(), mock: true };
  }
  const url = process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL;
  return { facilitator: createHttpFacilitator(url), mock: false };
}

/**
 * Runs the full x402 per-request happy path through core, server, and the
 * Express adapter: a service exposes a paid quote, an agent hits it, gets a
 * 402, pays, and receives the quote plus a canonical receipt that we then
 * verify. This is the Phase 0 exit criterion from docs/design.md,
 * "Build plan".
 */
export async function runDemo(): Promise<DemoResult> {
  const { facilitator, mock } = resolveFacilitator();
  const signer = await Ed25519Signer.generate("tollway-demo");

  const config: PaywallConfig = {
    amount: "10000",
    asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    network: "testnet",
    models: ["x402"],
  };

  const gate = createPaywall(config, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
  });

  const app = express();
  app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
    res.json({ symbol: "XLM/USD", price: "0.1234" });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const resource = `http://127.0.0.1:${port}/quotes/latest`;

  try {
    // The agent's first call carries no payment and gets the 402 challenge.
    const challenged = await fetch(resource);
    if (challenged.status !== 402) {
      throw new Error(`expected 402, got ${challenged.status}`);
    }
    const challengeHeader = challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
    const challenge = decodeHeader<{ amount: string; asset: string; resource: string }>(
      challengeHeader,
    );

    // The agent signs the authorization and retries. The mock facilitator
    // accepts any non-empty signature; real signing is the client's job.
    const paid = await fetch(resource, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
    });
    if (paid.status !== 200) {
      throw new Error(`expected 200 after payment, got ${paid.status}`);
    }
    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(PAYMENT_RESPONSE_HEADER) ?? "");
    const verification = await verifyReceipt(receipt, Ed25519Verifier.forSigner(signer));

    return { mock, challenge, receipt, receiptValid: verification.valid };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
