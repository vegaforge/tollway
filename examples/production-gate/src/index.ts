/**
 * A production gate configuration, checked by `pnpm typecheck` in this
 * workspace and described in apps/web/src/content/docs/deployment.mdx.
 *
 * It imports the real packages, so a change to `createRedisSettlementCache`,
 * `createHttpFacilitator`, `Ed25519Signer.fromPrivateKey` or `createPaywall`
 * breaks this file rather than silently making the guide wrong.
 *
 * The gate holds no funds. Payments settle to `STELLAR_RECIPIENT`; this
 * process signs receipts and coordinates duplicate settlement, nothing else.
 */

import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createHttpFacilitator,
  createPaywall,
  createRedisSettlementCache,
  type Gate,
  type GateOutcome,
  type RedisLikeClient,
} from "@vegaforge/tollway-server";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { Redis } from "ioredis";
import { z } from "zod";

/** OpenZeppelin Channels facilitator endpoints, as used by apps/demo. */
const FACILITATOR_URLS = {
  testnet: "https://channels.openzeppelin.com/x402/testnet",
  mainnet: "https://channels.openzeppelin.com/x402",
} as const;

const USDC_ADDRESSES = {
  testnet: USDC_TESTNET_ADDRESS,
  mainnet: USDC_PUBNET_ADDRESS,
} as const;

/**
 * The environment this gate needs. Every value is validated once, at startup,
 * so a missing secret or a fractional price is a refused boot rather than a
 * failure on a paying customer's request.
 */
const envSchema = z.object({
  /** Which chain the gate settles on. Same value in every process. */
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** G... account that receives payments. Tollway never sits in between. */
  STELLAR_RECIPIENT: z.string().min(1),
  /** Price as an integer string in the asset's smallest unit (USDC: 7 decimals). */
  PRICE_AMOUNT: z.string().regex(/^[0-9]+$/, "PRICE_AMOUNT must be an integer string"),
  /** USDC contract address (C...). One of the two known addresses by default. */
  STELLAR_ASSET: z.string().min(1).optional(),
  /** base64url Ed25519 private key: a 32-byte seed or a 48-byte PKCS#8 document. */
  RECEIPT_SIGNING_KEY: z.string().min(1),
  /** Stable id for that key, so rotation does not orphan receipts. */
  RECEIPT_KEY_ID: z.string().min(1).default("gate-1"),
  /** OpenZeppelin Channels API key, sent as Bearer to verify, settle and supported. */
  OZ_API_KEY: z.string().min(1),
  /** Overrides the default facilitator URL for the network. */
  FACILITATOR_URL: z.string().url().optional(),
  /** Shared Redis used for the settlement cache and its locks. */
  REDIS_URL: z.string().min(1),
  /** Cache TTL in milliseconds. Defaults to 30 000, about six ledger closes. */
  SETTLEMENT_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /** Cross-process lock TTL in milliseconds; renewed while a settlement runs. */
  SETTLEMENT_LOCK_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * How long an x402 authorization stays valid. Defaults to 60, the same
   * default the gate and the facilitator client use.
   */
  PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
});

export type GateEnv = z.infer<typeof envSchema>;

/** Parse and validate the environment, or throw with every problem listed. */
export function readGateEnv(source: Record<string, string | undefined> = process.env): GateEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "env"}: ${issue.message}`,
    );
    throw new Error(
      `gate configuration is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return parsed.data;
}

export type ProductionGateDeps = {
  /**
   * Called when the settlement cache or its lock fails after a payment
   * settled. The payer still gets the receipt; this is the alert.
   */
  onCacheError?: (error: Error, key: string) => void;
  /** Called for every settled or rejected outcome, for your own metrics. */
  onGateOutcome?: (outcome: GateOutcome) => void;
};

export type ProductionGate = {
  gate: Gate;
  /** Close the Redis connection during graceful shutdown. */
  close: () => Promise<void>;
};

/**
 * Build a gate for a multi-process deployment. Every process runs this same
 * function against the same Redis: the cache and the `SET NX PX` lock are
 * what keep one payment from settling twice across processes.
 */
export async function createProductionGate(
  env: GateEnv,
  deps: ProductionGateDeps = {},
): Promise<ProductionGate> {
  const signer = await Ed25519Signer.fromPrivateKey(env.RECEIPT_SIGNING_KEY, env.RECEIPT_KEY_ID);

  // maxRetriesPerRequest limits retries of a failed Redis command. A cache
  // failure before settlement fails the request; one after settlement
  // returns the receipt with cacheError set.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const client: RedisLikeClient = redis;
  const cache = createRedisSettlementCache({
    client,
    ttlMs: env.SETTLEMENT_CACHE_TTL_MS,
  });

  const facilitatorUrl = env.FACILITATOR_URL ?? FACILITATOR_URLS[env.STELLAR_NETWORK];
  const auth = { Authorization: `Bearer ${env.OZ_API_KEY}` };
  const facilitator = createHttpFacilitator(facilitatorUrl, {
    maxTimeoutSeconds: env.PAYMENT_TIMEOUT_SECONDS,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });

  const gate = createPaywall(
    {
      amount: env.PRICE_AMOUNT,
      asset: env.STELLAR_ASSET ?? USDC_ADDRESSES[env.STELLAR_NETWORK],
      payTo: env.STELLAR_RECIPIENT,
      network: env.STELLAR_NETWORK,
      models: ["x402"],
      maxTimeoutSeconds: env.PAYMENT_TIMEOUT_SECONDS,
    },
    {
      signer,
      facilitator,
      cache,
      settlementLockTtlMs: env.SETTLEMENT_LOCK_TTL_MS,
      ...(deps.onCacheError ? { onCacheError: deps.onCacheError } : {}),
    },
  );

  const observed: Gate = deps.onGateOutcome
    ? async (request) => {
        const outcome = await gate(request);
        deps.onGateOutcome?.(outcome);
        return outcome;
      }
    : gate;

  return {
    gate: observed,
    close: async () => {
      await redis.quit();
    },
  };
}
