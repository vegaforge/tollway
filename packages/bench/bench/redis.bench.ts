import {
  createRedisSettlementCache,
  type Gate,
  type RedisLikeClient,
} from "@vegaforge/tollway-server";
import RedisMock from "ioredis-mock";
import { beforeAll, bench, describe } from "vitest";
import {
  BENCH_OPTIONS,
  createBenchGate,
  expectSettled,
  paymentHeader,
  paymentSequence,
  RESOURCE_PATH,
} from "../src/fixtures.js";

/**
 * The settlement path with `createRedisSettlementCache` over `ioredis-mock`.
 * ioredis-mock answers in process, so these numbers are the cost of
 * Tollway's lock and cache code (the extra lookups, the SET NX lock, the Lua
 * release, the JSON round trip and schema parse of a stored receipt) and of
 * the mock itself. They say nothing about a real Redis, where each of those
 * calls is a network round trip.
 */

let gate: Gate;
const nextPayment = paymentSequence("redis-x402");
const REPLAYED_PAYMENT = paymentHeader("redis-replayed-payment");

beforeAll(async () => {
  // ioredis-mock's types describe the full ioredis client, whose overloads
  // TypeScript cannot match against the narrower RedisLikeClient one by
  // one. The server's own cache tests make the same conversion.
  const client = new RedisMock() as unknown as RedisLikeClient;
  gate = createBenchGate({ cache: createRedisSettlementCache({ client }) });
  expectSettled(
    await gate({
      method: "GET",
      url: RESOURCE_PATH,
      headers: { "PAYMENT-SIGNATURE": REPLAYED_PAYMENT },
    }),
    false,
  );
});

describe("gate with the Redis settlement cache (ioredis-mock)", () => {
  bench(
    "x402 fresh settlement",
    async () => {
      const outcome = await gate({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { "PAYMENT-SIGNATURE": nextPayment() },
      });
      expectSettled(outcome, false);
    },
    BENCH_OPTIONS,
  );

  bench(
    "x402 replayed settlement",
    async () => {
      const outcome = await gate({
        method: "GET",
        url: RESOURCE_PATH,
        headers: { "PAYMENT-SIGNATURE": REPLAYED_PAYMENT },
      });
      expectSettled(outcome, true);
    },
    BENCH_OPTIONS,
  );
});
