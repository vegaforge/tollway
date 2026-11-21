import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createMockMppChargeHandler,
  createPaywall,
  encodePaymentSignatureHeader,
  type Gate,
  type GateOutcome,
  type PaywallConfig,
  type SettlementCache,
} from "@vegaforge/tollway-server";

/**
 * Shared inputs for every benchmark. Everything here is fixed or derived
 * from a counter, so two runs do the same work in the same order: no
 * network, no random payments, and no timers beyond the clock the gate
 * itself reads for receipt timestamps and cache expiry.
 */

export const RESOURCE_PATH = "/quotes/latest";

export const PRICE = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

/** How many callers send the same payment at once in the concurrency benchmark. */
export const CONCURRENT_CALLERS = 16;

/**
 * Timing for every benchmark. Each task warms up first so the JIT has
 * compiled the hot path before samples are kept, then samples for a full
 * second. The suite runs base and head up to three times each in CI, so
 * a longer window would mostly add minutes, not precision.
 */
export const BENCH_OPTIONS = {
  time: 1_000,
  warmupTime: 250,
  warmupIterations: 50,
} as const;

/**
 * One signer for the whole run, generated before any task measures. Its key
 * is random, but an Ed25519 signature costs the same for every key, so the
 * timings do not depend on it.
 */
export const signer = await Ed25519Signer.generate("bench-key");

/**
 * A PAYMENT-SIGNATURE header value as a stock x402 V2 client writes it: the
 * standard-base64 JSON of a `PaymentPayload` that accepts the bench price.
 * The mock facilitator derives the payer and nonce from `transaction`, so
 * two headers with the same transaction are the same payment.
 */
export function paymentHeader(transaction: string): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: PRICE.asset,
      amount: PRICE.amount,
      payTo: PRICE.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  });
}

/**
 * Returns a function that yields a new payment header on every call, for
 * the transactions `<prefix>-0`, `<prefix>-1`, and so on. A fresh settlement
 * needs a payment the cache has never seen, and a counter gives that
 * without randomness.
 */
export function paymentSequence(prefix: string): () => string {
  const nextCredential = credentialSequence(prefix);
  return () => paymentHeader(nextCredential());
}

/**
 * Returns a function that yields a new raw credential on every call:
 * `<prefix>-0`, `<prefix>-1`, and so on. The mock MPP handler takes the
 * credential as is from `Authorization: Payment <credential>`.
 */
export function credentialSequence(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${next++}`;
}

/**
 * An in-memory cache filled to its default size cap (10 000 entries) with
 * entries no benchmark will ask for. A busy production gate runs with a full
 * cache, where every new settlement also evicts the oldest entry. Starting
 * full keeps every sample in that one regime instead of switching to it
 * part way through the run, which would happen at a different point on a
 * faster or slower machine.
 */
export async function fullInMemoryCache(seed: GateOutcome): Promise<SettlementCache> {
  const cache = createInMemorySettlementCache();
  const settled = expectSettled(seed, false);
  for (let i = 0; i < 10_000; i++) {
    await cache.set(`x402:filler-${i}`, { receipt: settled.receipt, method: "GET" });
  }
  return cache;
}

/** A gate with the mock facilitator and mock MPP handler, as the demo's MOCK_MODE builds it. */
export function createBenchGate(options: {
  cache?: SettlementCache;
  models?: PaywallConfig["models"];
}): Gate {
  return createPaywall(
    { ...PRICE, models: options.models ?? ["x402"] },
    {
      signer,
      facilitator: createMockFacilitator(),
      mppChargeHandler: createMockMppChargeHandler(),
      cache: options.cache,
    },
  );
}

/**
 * A receipt to fill caches with, from one settlement on a throwaway gate.
 * Settling it here also checks the gate works before anything is timed.
 */
export async function seedOutcome(): Promise<GateOutcome> {
  const gate = createBenchGate({});
  return gate({
    method: "GET",
    url: RESOURCE_PATH,
    headers: { "PAYMENT-SIGNATURE": paymentHeader("seed-payment") },
  });
}

type Settled = Extract<GateOutcome, { kind: "settled" }>;

/**
 * Throws unless the outcome is a settlement with the expected replay flag.
 * A benchmark that silently took another branch (a 409, a 402) would report
 * the speed of the wrong path, so every task checks what it measured.
 */
export function expectSettled(outcome: GateOutcome, replayed: boolean): Settled {
  if (outcome.kind !== "settled") {
    throw new Error(`expected a settlement, got ${outcome.kind} (${describe(outcome)})`);
  }
  if (outcome.replayed !== replayed) {
    throw new Error(`expected replayed=${replayed}, got replayed=${outcome.replayed}`);
  }
  return outcome;
}

/** Throws unless the outcome is the 402 challenge. */
export function expectChallenge(outcome: GateOutcome): void {
  if (outcome.kind !== "payment-required") {
    throw new Error(`expected a 402 challenge, got ${outcome.kind} (${describe(outcome)})`);
  }
}

/** Throws unless an HTTP response has the expected status. */
export function expectStatus(actual: number, expected: number, adapter: string): void {
  if (actual !== expected) {
    throw new Error(`${adapter}: expected HTTP ${expected}, got ${actual}`);
  }
}

function describe(outcome: GateOutcome): string {
  return outcome.kind === "rejected" ? `${outcome.status} ${outcome.reason}` : `${outcome.status}`;
}
