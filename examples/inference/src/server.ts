import { pathToFileURL } from "node:url";
import { expressPaywall, RECEIPT_LOCALS_KEY } from "@vegaforge/tollway-adapter-express";
import { Ed25519Signer, type SignedReceipt } from "@vegaforge/tollway-core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  type FacilitatorClient,
} from "@vegaforge/tollway-server";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import express, { type Express, type RequestHandler } from "express";

/**
 * An inference API that charges per call. One route, POST /complete, sits
 * behind expressPaywall(createPaywall(...)): the gate answers 402 until the
 * request carries a payment, settles it once, and hands the route a signed
 * receipt. The route itself holds no payment logic.
 */

/** 0.001 USDC in 7-decimal base units: the price of one completion. */
export const COMPLETION_PRICE = "10000";

/** Longest prompt the route accepts, so one request cannot pin the process. */
export const MAX_PROMPT_LENGTH = 4_000;

/**
 * The OpenZeppelin Channels x402 facilitator on testnet, the same default
 * apps/demo uses (docs/adr/ADR-2026-10-29-demo-facilitator-defaults.md).
 */
export const TESTNET_FACILITATOR_URL = "https://channels.openzeppelin.com/x402/testnet";

/**
 * A real testnet account generated for this example, so the defaults are
 * valid on the wire. Its secret was discarded: set TOLLWAY_PAY_TO to an
 * account you control before taking real testnet payments.
 */
export const DEFAULT_TESTNET_PAY_TO = "GAKNQS3I24B4UK73ZOATTAV73RIWSZ5IZ64JL5GQWZGIJFHSBINIBWCI";

/** Testnet USDC, from @x402/stellar so it cannot drift from the facilitator's. */
export const DEFAULT_TESTNET_ASSET = USDC_TESTNET_ADDRESS;

/** Matches the default `maxTimeoutSeconds` in createHttpFacilitator. */
const MAX_TIMEOUT_SECONDS = 60;

/**
 * OpenZeppelin Channels pays the network fee. The agent's @x402/stellar
 * client refuses to build a payment unless the requirements say so, and the
 * gate sends the same `extra` to the facilitator. Same as apps/demo.
 */
const SPONSORED_FEES = { areFeesSponsored: true };

// Shape checks only (prefix, alphabet, length). The facilitator validates
// the checksum when it builds the payment.
const ACCOUNT_ID = /^G[A-Z2-7]{55}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export type ExampleEnv = Readonly<Record<string, string | undefined>>;

/** Thrown when the environment cannot start the service. Lists every problem. */
export class ExampleConfigError extends Error {
  override readonly name = "ExampleConfigError";
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`inference cannot start:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

export type InferenceService = {
  app: Express;
  /** Signs every receipt. Its public key is what a caller verifies against. */
  signer: Ed25519Signer;
  mode: "mock" | "testnet";
};

function buildFacilitator(env: ExampleEnv, problems: string[]): FacilitatorClient {
  if ((env.TOLLWAY_MODE || "mock") === "mock") {
    return createMockFacilitator();
  }
  const apiKey = env.OZ_API_KEY ?? "";
  if (!apiKey) {
    problems.push(
      "OZ_API_KEY is not set. Generate a testnet key at https://channels.openzeppelin.com/testnet/gen",
    );
  }
  const auth = { Authorization: `Bearer ${apiKey}` };
  return createHttpFacilitator(env.FACILITATOR_URL || TESTNET_FACILITATOR_URL, {
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: SPONSORED_FEES,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
}

/**
 * Refuses a body the model could not use before the gate runs, so a
 * malformed request gets 400 and is never charged.
 */
const requirePrompt: RequestHandler = (req, res, next) => {
  const prompt: unknown = req.body?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: 'body must be JSON of the form { "prompt": "..." }' });
    return;
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    res.status(400).json({ error: `"prompt" is limited to ${MAX_PROMPT_LENGTH} characters` });
    return;
  }
  next();
};

/** A stand-in for a real model: the same sentence for every prompt. */
function complete(prompt: string): string {
  return `You asked ${prompt.trim().split(/\s+/).length} words; this canned completion answers none of them.`;
}

/** Builds the service from an environment. Throws ExampleConfigError on bad config. */
export async function createInferenceService(env: ExampleEnv): Promise<InferenceService> {
  const problems: string[] = [];

  const modeValue = env.TOLLWAY_MODE || "mock";
  if (modeValue !== "mock" && modeValue !== "testnet") {
    problems.push(`TOLLWAY_MODE must be "mock" or "testnet", got "${modeValue}"`);
  }
  const payTo = env.TOLLWAY_PAY_TO || DEFAULT_TESTNET_PAY_TO;
  if (!ACCOUNT_ID.test(payTo)) {
    problems.push("TOLLWAY_PAY_TO is not a Stellar account id (G..., 56 characters)");
  }
  const asset = env.TOLLWAY_ASSET || DEFAULT_TESTNET_ASSET;
  if (!CONTRACT_ID.test(asset)) {
    problems.push("TOLLWAY_ASSET is not a Soroban contract address (C..., 56 characters)");
  }
  const facilitator = buildFacilitator(env, problems);
  if (problems.length > 0) {
    throw new ExampleConfigError(problems);
  }

  // A key per process keeps the example to one file. A real service loads a
  // stable key so receipts verify after a restart: see examples/next-paid-api.
  const signer = await Ed25519Signer.generate("tollway-example-inference");
  const gate = createPaywall(
    {
      amount: COMPLETION_PRICE,
      asset,
      payTo,
      network: "testnet",
      models: ["x402"],
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: SPONSORED_FEES,
    },
    { signer, facilitator, cache: createInMemorySettlementCache() },
  );

  const app = express();
  app.post(
    "/complete",
    express.json({ limit: "16kb" }),
    requirePrompt,
    expressPaywall(gate),
    (req, res) => {
      const receipt = res.locals[RECEIPT_LOCALS_KEY] as SignedReceipt;
      res.json({
        model: "canned-1",
        completion: complete(req.body.prompt),
        receiptId: receipt.receipt.id,
      });
    },
  );

  return { app, signer, mode: modeValue === "testnet" ? "testnet" : "mock" };
}

async function main(): Promise<void> {
  const { app, mode } = await createInferenceService(process.env);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`inference example listening on http://127.0.0.1:${port} (${mode} mode)`);
    console.log(`POST /complete costs ${COMPLETION_PRICE} (0.001 USDC) per call`);
  });
}

// Start only when this file is the entry point, so the test can import it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // A configuration problem is the operator's to fix, so print the list
    // without a stack trace. Anything else keeps its stack.
    if (error instanceof ExampleConfigError) {
      console.error(error.message);
    } else {
      console.error("inference example failed to start:", error);
    }
    process.exitCode = 1;
  });
}
