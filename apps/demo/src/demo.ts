import type { AddressInfo } from "node:net";
import { expressPaywall } from "@tollway/adapter-express";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  type SignedReceipt,
  type StellarNetwork,
  verifyReceipt,
} from "@tollway/core";
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
import {
  createEd25519Signer,
  ExactStellarScheme,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
} from "@x402/stellar";
import express from "express";
import { type DemoEnv, type LiveDemoConfig, resolveDemoConfig } from "./config.js";

/** The x402 payment requirements the @x402/stellar client signs against. */
export type PaymentRequirements = Parameters<ExactStellarScheme["createPaymentPayload"]>[1];

/**
 * Produces the PAYMENT-SIGNATURE value for an offer. In live mode that is the
 * base64 Stellar transaction from @x402/stellar, which the gate's HTTP
 * facilitator forwards as `payload.transaction`.
 */
export type DemoPayer = (requirements: PaymentRequirements) => Promise<string>;

export type DemoOptions = {
  /** Defaults to process.env. */
  env?: DemoEnv;
  /** Overrides the live-mode payer. Tests use it to avoid Stellar RPC. */
  payer?: DemoPayer;
};

export type DemoResult = {
  mock: boolean;
  challenge: { amount: string; asset: string; resource: string };
  receipt: SignedReceipt;
  receiptValid: boolean;
};

/** Price of the demo quote: 0.001 USDC in 7-decimal base units. */
const DEMO_AMOUNT = "10000";

/** x402 V2, the version the gate's HTTP facilitator speaks. */
const X402_VERSION = 2;

/** Matches the default `maxTimeoutSeconds` in createHttpFacilitator. */
const MAX_TIMEOUT_SECONDS = 60;

/**
 * OpenZeppelin Channels pays the network fee. The @x402/stellar client refuses
 * to build a payment unless the requirements say so, and the gate sends the
 * same `extra` to the facilitator so both sides agree.
 */
const SPONSORED_FEES = { areFeesSponsored: true };

const NETWORK_CAIP2 = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
} as const satisfies Record<StellarNetwork, string>;

/** Placeholder accounts for mock mode only. The mock facilitator never checks them. */
const MOCK_PAYWALL = {
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} as const;

const mockPayer: DemoPayer = async () => "mock-signed-auth-entry";

/** Signs a real payment with the payer's secret seed through @x402/stellar. */
function createStellarPayer(config: LiveDemoConfig): DemoPayer {
  const signer = createEd25519Signer(config.payerSecret, NETWORK_CAIP2[config.network]);
  const scheme = new ExactStellarScheme(signer, config.rpcUrl ? { url: config.rpcUrl } : undefined);
  return async (requirements) => {
    const { payload } = await scheme.createPaymentPayload(X402_VERSION, requirements);
    if (typeof payload.transaction !== "string") {
      throw new Error("@x402/stellar returned a payment payload without a transaction");
    }
    return payload.transaction;
  };
}

type DemoSetup = {
  mock: boolean;
  facilitator: FacilitatorClient;
  paywall: Pick<PaywallConfig, "asset" | "payTo" | "network">;
  payer: DemoPayer;
};

function setUp(options: DemoOptions): DemoSetup {
  const config = resolveDemoConfig(options.env ?? process.env);
  if (config.mode === "mock") {
    return {
      mock: true,
      facilitator: createMockFacilitator(),
      paywall: MOCK_PAYWALL,
      payer: options.payer ?? mockPayer,
    };
  }

  const auth = { Authorization: `Bearer ${config.apiKey}` };
  return {
    mock: false,
    facilitator: createHttpFacilitator(config.facilitatorUrl, {
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: SPONSORED_FEES,
      createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
    }),
    paywall: { asset: config.asset, payTo: config.recipient, network: config.network },
    payer: options.payer ?? createStellarPayer(config),
  };
}

/**
 * The x402 requirements for an offer, as the agent signs them. The offer comes
 * off the wire, so its network is checked before it picks a CAIP-2 id;
 * @x402/stellar validates the amount and addresses itself.
 */
function toRequirements(offer: PaymentOffer): PaymentRequirements {
  const network: string = offer.network;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`challenge names an unknown network "${network}"`);
  }
  return {
    scheme: "exact",
    network: NETWORK_CAIP2[network],
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: SPONSORED_FEES,
  };
}

/**
 * Runs the x402 per-request happy path through core, server, and the Express
 * adapter: a service exposes a paid quote; an agent hits it, gets a 402, pays,
 * and receives the quote plus a canonical receipt, which we verify.
 *
 * Throws a DemoConfigError before any network call if live mode is not
 * configured.
 */
export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const { mock, facilitator, paywall, payer } = setUp(options);
  const signer = await Ed25519Signer.generate("tollway-demo");

  const config: PaywallConfig = { ...paywall, amount: DEMO_AMOUNT, models: ["x402"] };

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
    const challenge = decodeHeader<PaymentOffer>(
      challenged.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );

    // The agent pays for exactly what the challenge asks and retries.
    const paymentSignature = await payer(toRequirements(challenge));
    const paid = await fetch(resource, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature },
    });
    if (paid.status !== 200) {
      throw new Error(`expected 200 after payment, got ${paid.status}: ${await paid.text()}`);
    }
    const receipt = decodeHeader<SignedReceipt>(paid.headers.get(PAYMENT_RESPONSE_HEADER) ?? "");
    const verification = await verifyReceipt(receipt, Ed25519Verifier.forSigner(signer));

    return {
      mock,
      challenge: {
        amount: challenge.amount,
        asset: challenge.asset,
        resource: challenge.resource,
      },
      receipt,
      receiptValid: verification.valid,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
