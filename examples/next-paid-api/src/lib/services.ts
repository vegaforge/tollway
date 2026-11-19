import { type PaidHandler, withPaywall } from "@vegaforge/tollway-adapter-next";
import { Ed25519Signer, TollwayError } from "@vegaforge/tollway-core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  createRedisSettlementCache,
  type FacilitatorClient,
  type PaywallConfig,
  type SettlementCache,
} from "@vegaforge/tollway-server";
import { Redis } from "ioredis";
import { type ExampleConfig, ExampleConfigError, type ExampleEnv, resolveConfig } from "./config";
import { toSettlementCacheClient } from "./redis";

/**
 * Everything one instance of the service builds once: the receipt signer,
 * the facilitator, the settlement cache and the paywalled handlers. Nothing
 * in here depends on a request. See the issue's note on module scope (#250).
 */

/** 0.001 USDC in 7-decimal base units. */
export const QUOTE_PRICE = "10000";

/** 0.005 USDC in 7-decimal base units: summaries cost more than quotes. */
export const SUMMARIZE_PRICE = "50000";

/** Longest text /api/summarize accepts, so one request cannot pin the instance. */
export const MAX_SUMMARY_INPUT = 10_000;

/** Matches the default `maxTimeoutSeconds` in createHttpFacilitator. */
const MAX_TIMEOUT_SECONDS = 60;

/**
 * OpenZeppelin Channels pays the network fee. The agent's @x402/stellar
 * client refuses to build a payment unless the requirements say so, and the
 * gate sends the same `extra` to the facilitator. Same as apps/demo.
 */
const SPONSORED_FEES = { areFeesSponsored: true };

export type Services = {
  config: ExampleConfig;
  signer: Ed25519Signer;
  facilitator: FacilitatorClient;
  routes: {
    quote: (request: Request) => Promise<Response>;
    summarize: (request: Request) => Promise<Response>;
  };
};

async function loadSigner(config: ExampleConfig): Promise<Ed25519Signer> {
  if (!config.receiptKey) {
    // resolveConfig only allows a missing key in local mock mode.
    return Ed25519Signer.generate("next-paid-api-mock");
  }
  try {
    return await Ed25519Signer.fromPrivateKey(config.receiptKey, config.receiptKeyId);
  } catch (error) {
    // The core error names the problem without the key, so it is safe to
    // surface. Anything else is unexpected and propagates unchanged.
    if (error instanceof TollwayError && error.code === "invalid-signing-key") {
      throw new ExampleConfigError([`TOLLWAY_RECEIPT_KEY is malformed: ${error.message}`]);
    }
    throw error;
  }
}

function buildFacilitator(config: ExampleConfig): FacilitatorClient {
  if (config.facilitator.kind === "mock") {
    return createMockFacilitator();
  }
  const auth = { Authorization: `Bearer ${config.facilitator.apiKey}` };
  return createHttpFacilitator(config.facilitator.url, {
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: SPONSORED_FEES,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
}

function buildCache(config: ExampleConfig): SettlementCache {
  if (config.redisUrl) {
    return createRedisSettlementCache({
      client: toSettlementCacheClient(new Redis(config.redisUrl)),
      keyPrefix: "next-paid-api:settlement:",
    });
  }
  return createInMemorySettlementCache();
}

const quote: PaidHandler = (_request, { receipt }) =>
  Response.json({
    symbol: "XLM/USD",
    price: "0.1234",
    receiptId: receipt.receipt.id,
  });

/**
 * Runs only after payment. The route checked the body on a clone before the
 * gate, and withPaywall never reads the body, so it is still unread here.
 */
const summarize: PaidHandler = async (request, { receipt }) => {
  const { text } = parseSummarizeBody(await request.json());
  return Response.json({ summary: summarizeText(text), receiptId: receipt.receipt.id });
};

/** Thrown for a request body /api/summarize cannot use. */
export class SummarizeBodyError extends Error {
  override readonly name = "SummarizeBodyError";
}

export function parseSummarizeBody(body: unknown): { text: string } {
  if (typeof body !== "object" || body === null || !("text" in body)) {
    throw new SummarizeBodyError('body must be JSON of the form { "text": "..." }');
  }
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") {
    throw new SummarizeBodyError('"text" must be a non-empty string');
  }
  if (text.length > MAX_SUMMARY_INPUT) {
    throw new SummarizeBodyError(`"text" is limited to ${MAX_SUMMARY_INPUT} characters`);
  }
  return { text };
}

/** A stand-in for a real model: the first sentence, capped at 30 words. */
export function summarizeText(text: string): string {
  const firstSentence = text.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const words = firstSentence.split(/\s+/);
  return words.length > 30 ? `${words.slice(0, 30).join(" ")}...` : firstSentence;
}

/** Builds the service from an environment. Throws ExampleConfigError on bad config. */
export async function createServices(env: ExampleEnv): Promise<Services> {
  const config = resolveConfig(env);
  const signer = await loadSigner(config);
  const facilitator = buildFacilitator(config);
  // One cache for both routes: the gate binds each cached receipt to its
  // offer, so a payment for a quote can never unlock a summary.
  const cache = buildCache(config);
  const base: Omit<PaywallConfig, "amount"> = {
    asset: config.asset,
    payTo: config.payTo,
    network: config.network,
    models: ["x402"],
  };
  const deps = { signer, facilitator, cache };
  return {
    config,
    signer,
    facilitator,
    routes: {
      quote: withPaywall(createPaywall({ ...base, amount: QUOTE_PRICE }, deps), quote),
      summarize: withPaywall(createPaywall({ ...base, amount: SUMMARIZE_PRICE }, deps), summarize),
    },
  };
}

let instance: Promise<Services> | undefined;

/**
 * The instance's services, built on first use and then shared by every
 * request. A configuration error is kept, so every request reports it
 * instead of half the service starting.
 */
export function getServices(): Promise<Services> {
  instance ??= createServices(process.env);
  return instance;
}
