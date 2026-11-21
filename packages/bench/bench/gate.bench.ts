import type { Gate } from "@vegaforge/tollway-server";
import { beforeAll, bench, describe } from "vitest";
import {
  BENCH_OPTIONS,
  CONCURRENT_CALLERS,
  createBenchGate,
  credentialSequence,
  expectChallenge,
  expectSettled,
  fullInMemoryCache,
  paymentHeader,
  paymentSequence,
  RESOURCE_PATH,
  seedOutcome,
} from "../src/fixtures.js";

/**
 * The gate on its own, with the mock facilitator, the mock MPP handler and
 * the in-memory settlement cache. No framework and no network: this is the
 * cost of Tollway's own payment path per request.
 */

let x402Gate: Gate;
let replayGate: Gate;
let mppGate: Gate;
const nextX402Payment = paymentSequence("gate-x402");
const nextMppPayment = credentialSequence("gate-mpp");
const nextConcurrentPayment = paymentSequence("gate-concurrent");
const REPLAYED_PAYMENT = paymentHeader("gate-replayed-payment");

beforeAll(async () => {
  const seed = await seedOutcome();
  x402Gate = createBenchGate({ cache: await fullInMemoryCache(seed) });
  // The replay has a gate of its own: the fresh-settlement task fills the
  // shared cache past its cap, which would evict the replayed entry.
  replayGate = createBenchGate({ cache: await fullInMemoryCache(seed) });
  mppGate = createBenchGate({ cache: await fullInMemoryCache(seed), models: ["mpp-charge"] });
  // Settle the replayed payment once, so every timed request is a replay.
  expectSettled(
    await replayGate({
      method: "GET",
      url: RESOURCE_PATH,
      headers: { "PAYMENT-SIGNATURE": REPLAYED_PAYMENT },
    }),
    false,
  );
});

describe("gate", () => {
  bench(
    "402 challenge",
    async () => {
      expectChallenge(await x402Gate({ method: "GET", url: RESOURCE_PATH, headers: {} }));
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 fresh settlement",
    async () => {
      const outcome = await x402Gate({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { "PAYMENT-SIGNATURE": nextX402Payment() },
      });
      expectSettled(outcome, false);
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 replayed settlement",
    async () => {
      const outcome = await replayGate({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { "PAYMENT-SIGNATURE": REPLAYED_PAYMENT },
      });
      expectSettled(outcome, true);
    },
    BENCH_OPTIONS,
  );

  bench(
    "mpp-charge fresh settlement",
    async () => {
      const outcome = await mppGate({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { Authorization: `Payment ${nextMppPayment()}` },
      });
      expectSettled(outcome, false);
    },
    BENCH_OPTIONS,
  );

  // One sample is all N callers: the time until every one of them has an
  // answer. Exactly one of them may settle; the rest wait on it in process.
  bench(
    `x402 ${CONCURRENT_CALLERS} concurrent identical payments`,
    async () => {
      const payment = nextConcurrentPayment();
      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_CALLERS }, () =>
          x402Gate({
            method: "GET",
            url: RESOURCE_PATH,
            headers: { "PAYMENT-SIGNATURE": payment },
          }),
        ),
      );
      const fresh = outcomes.filter(
        (outcome) => outcome.kind === "settled" && !outcome.replayed,
      ).length;
      if (fresh !== 1) {
        throw new Error(`expected exactly one settlement among the callers, got ${fresh}`);
      }
      for (const outcome of outcomes) {
        if (outcome.kind !== "settled") {
          throw new Error(`expected every caller to get the receipt, got ${outcome.kind}`);
        }
      }
    },
    BENCH_OPTIONS,
  );
});
