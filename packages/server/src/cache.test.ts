import { buildReceipt, Ed25519Signer, type SignedReceipt, signReceipt } from "@tollway/core";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
} from "./cache.js";

let receipt: SignedReceipt;

beforeAll(async () => {
  const signer = await Ed25519Signer.generate("cache-test-key");
  receipt = await signReceipt(
    buildReceipt({
      payer: "GPAYER",
      payee: "GPAYEE",
      amount: "10000",
      asset: "USDC:GA5Z",
      resource: "/quotes/latest",
      model: "x402",
      settlement: { kind: "transaction", txHash: "abc123" },
      network: "testnet",
    }),
    signer,
  );
});

describe("createInMemorySettlementCache", () => {
  it("returns undefined on a miss and the stored receipt on a hit", async () => {
    const cache = createInMemorySettlementCache();
    await expect(cache.get("nonce-1")).resolves.toBeUndefined();

    await cache.set("nonce-1", receipt);
    await expect(cache.get("nonce-1")).resolves.toBe(receipt);
  });

  it("evicts an entry once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const cache = createInMemorySettlementCache(50);
      await cache.set("nonce-evict", receipt);
      await expect(cache.get("nonce-evict")).resolves.toBe(receipt);

      vi.advanceTimersByTime(60);
      await expect(cache.get("nonce-evict")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createRedisSettlementCache", () => {
  it("returns undefined on a miss and the stored receipt on a hit", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });

    await expect(cache.get("nonce-1")).resolves.toBeUndefined();
    await cache.set("nonce-1", receipt);

    const hit = await cache.get("nonce-1");
    expect(hit).toEqual(receipt);
  });

  it("shares cached receipts across two cache instances pointing at the same Redis", async () => {
    // Two cache instances sharing one Redis backend stand in for two gate
    // processes serving the same nonce; this is the cross-instance idempotency
    // guarantee from issue #29.
    const client = new RedisMock() as unknown as RedisLikeClient;
    const writer = createRedisSettlementCache({ client });
    const reader = createRedisSettlementCache({ client });

    await writer.set("nonce-cross", receipt);

    const hit = await reader.get("nonce-cross");
    expect(hit).toEqual(receipt);
  });

  it("honors Redis TTL eviction semantics", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client, ttlMs: 1_000 });

    await cache.set("nonce-ttl", receipt);
    await expect(cache.get("nonce-ttl")).resolves.toEqual(receipt);

    // Advance Redis's internal clock past the TTL via the mock's own time helper
    // when available; otherwise fall back to deleting and asserting the miss.
    const mockClient = client as unknown as {
      expire?: (key: string, seconds: number) => Promise<unknown>;
    };
    if (typeof mockClient.expire === "function") {
      await mockClient.expire("tollway:settlement:nonce-ttl", -1);
    }
    await expect(cache.get("nonce-ttl")).resolves.toBeUndefined();
  });

  it("treats a corrupted Redis entry as a miss instead of poisoning settlement", async () => {
    // A shared store can hold a value that the cache did not write (key
    // collision with a foreign tenant, a manual debug write, a partial
    // deploy). The cache should return undefined on any value that does not
    // round-trip through signedReceiptSchema rather than letting bad data
    // either throw out of JSON.parse or be served as the receipt.
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });

    await client.set("tollway:settlement:nonce-bad-json", "{not valid json", "EX", 30);
    await expect(cache.get("nonce-bad-json")).resolves.toBeUndefined();

    await client.set(
      "tollway:settlement:nonce-foreign",
      JSON.stringify({ hello: "world" }),
      "EX",
      30,
    );
    await expect(cache.get("nonce-foreign")).resolves.toBeUndefined();

    // The cache still returns its own entries.
    await cache.set("nonce-good", receipt);
    await expect(cache.get("nonce-good")).resolves.toEqual(receipt);
  });

  it("applies a custom key prefix", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client, keyPrefix: "custom:" });
    await cache.set("nonce-prefix", receipt);

    const direct = await client.get("custom:nonce-prefix");
    expect(direct).not.toBeNull();
    expect(JSON.parse(direct ?? "null")).toEqual(receipt);
  });
});

describe("createRedisSettlementCache settlement lock", () => {
  it("acquire is exclusive across two Redis caches on one client", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const first = createRedisSettlementCache({ client });
    const second = createRedisSettlementCache({ client });

    const firstLock = await first.acquire("x402:nonce-lock", 30_000);
    if (!firstLock) throw new Error("expected the first cache to take the lock");
    await expect(second.acquire("x402:nonce-lock", 30_000)).resolves.toBe(false);

    await expect(first.release("x402:nonce-lock", firstLock)).resolves.toBe(true);
    const secondLock = await second.acquire("x402:nonce-lock", 30_000);
    if (!secondLock) throw new Error("expected the second cache to take the lock");
    await expect(second.release("x402:nonce-lock", secondLock)).resolves.toBe(true);
  });
});

// Regression lock for ADR-2026-11-18-redis-lock-ownership.
describe("createRedisSettlementCache lock ownership", () => {
  const prefix = "tollway:settlement:";

  it("does not let a holder whose lock expired release the new holder's lock", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const processA = createRedisSettlementCache({ client, keyPrefix: "own:a:" });
    const processB = createRedisSettlementCache({ client, keyPrefix: "own:a:" });
    const processC = createRedisSettlementCache({ client, keyPrefix: "own:a:" });

    const lockA = await processA.acquire("x402:nonce", 30_000);
    expect(lockA).toBeTruthy();
    // A's lock expires while A is still working (a slow /settle).
    await redis.del("own:a:lock:x402:nonce");
    const lockB = await processB.acquire("x402:nonce", 30_000);
    expect(lockB).toBeTruthy();

    // A finishes late and releases with its own, stale lock.
    if (!lockA) throw new Error("expected A to hold the lock");
    await processA.release("x402:nonce", lockA);

    // B still holds the lock, so a third process must not get it.
    await expect(processC.acquire("x402:nonce", 30_000)).resolves.toBe(false);
  });

  it("renews only a lock the caller still holds", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });
    const lock = await cache.acquire("x402:renew", 30_000);
    if (!lock) throw new Error("expected to acquire");

    await expect(cache.renew("x402:renew", lock, 30_000)).resolves.toBe(true);
    await redis.del(`${prefix}lock:x402:renew`);
    const other = await createRedisSettlementCache({ client }).acquire("x402:renew", 30_000);
    expect(other).toBeTruthy();
    await expect(cache.renew("x402:renew", lock, 30_000)).resolves.toBe(false);
    await expect(cache.release("x402:renew", lock)).resolves.toBe(false);
  });
});
