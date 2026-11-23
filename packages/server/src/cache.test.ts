import {
  buildReceipt,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementEntry,
} from "./cache.js";

let receipt: SignedReceipt;
let entry: SettlementEntry;

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
  entry = { receipt, method: "GET" };
});

describe("createInMemorySettlementCache", () => {
  it("returns undefined on a miss and the stored receipt on a hit", async () => {
    const cache = createInMemorySettlementCache();
    await expect(cache.get("nonce-1")).resolves.toBeUndefined();

    await cache.set("nonce-1", entry);
    await expect(cache.get("nonce-1")).resolves.toBe(entry);
  });

  it("evicts an entry once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const cache = createInMemorySettlementCache(50);
      await cache.set("nonce-evict", entry);
      await expect(cache.get("nonce-evict")).resolves.toBe(entry);

      vi.advanceTimersByTime(60);
      await expect(cache.get("nonce-evict")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still misses on get for an expired entry, using the injected clock", async () => {
    let now = 1_000;
    const cache = createInMemorySettlementCache(50, { now: () => now });
    await cache.set("nonce-a", entry);
    now += 49;
    await expect(cache.get("nonce-a")).resolves.toBe(entry);
    now += 1;
    await expect(cache.get("nonce-a")).resolves.toBeUndefined();
  });

  it("evicts the oldest entry once maxEntries is reached", async () => {
    const cache = createInMemorySettlementCache(60_000, { maxEntries: 2, now: () => 0 });
    await cache.set("first", entry);
    await cache.set("second", entry);
    await cache.set("third", entry);

    await expect(cache.get("first")).resolves.toBeUndefined();
    await expect(cache.get("second")).resolves.toBe(entry);
    await expect(cache.get("third")).resolves.toBe(entry);
  });

  it("does not evict another entry when an existing key is overwritten at the cap", async () => {
    const cache = createInMemorySettlementCache(60_000, { maxEntries: 2, now: () => 0 });
    await cache.set("first", entry);
    await cache.set("second", entry);
    await cache.set("second", entry);

    await expect(cache.get("first")).resolves.toBe(entry);
    await expect(cache.get("second")).resolves.toBe(entry);
  });

  it("treats an overwritten key as the newest entry", async () => {
    let now = 0;
    const cache = createInMemorySettlementCache(100, { maxEntries: 2, now: () => now });
    await cache.set("first", entry);
    await cache.set("second", entry);
    now = 10;
    await cache.set("first", entry);
    await cache.set("third", entry);

    await expect(cache.get("second")).resolves.toBeUndefined();
    await expect(cache.get("first")).resolves.toBe(entry);
    await expect(cache.get("third")).resolves.toBe(entry);
  });

  it("sweeps expired entries on set, from the oldest end", async () => {
    let now = 0;
    const cache = createInMemorySettlementCache(100, { maxEntries: 3, now: () => now });
    await cache.set("old-1", entry);
    await cache.set("old-2", entry);
    now = 50;
    await cache.set("young", entry);

    // old-1 and old-2 expire at 100; young expires at 150. The next set
    // sweeps both expired entries, so the cap of 3 is not reached and young
    // survives.
    now = 120;
    await cache.set("new-1", entry);
    await cache.set("new-2", entry);

    await expect(cache.get("young")).resolves.toBe(entry);
    await expect(cache.get("new-1")).resolves.toBe(entry);
    await expect(cache.get("new-2")).resolves.toBe(entry);
    await expect(cache.get("old-1")).resolves.toBeUndefined();
  });

  it("defaults maxEntries to 10000", async () => {
    const cache = createInMemorySettlementCache(60_000, { now: () => 0 });
    for (let index = 0; index <= 10_000; index += 1) {
      await cache.set(`nonce-${index}`, entry);
    }
    await expect(cache.get("nonce-0")).resolves.toBeUndefined();
    await expect(cache.get("nonce-1")).resolves.toBe(entry);
    await expect(cache.get("nonce-10000")).resolves.toBe(entry);
  });

  it("rejects a maxEntries that is not a positive integer", () => {
    expect(() => createInMemorySettlementCache(1_000, { maxEntries: 0 })).toThrow(RangeError);
    expect(() => createInMemorySettlementCache(1_000, { maxEntries: 1.5 })).toThrow(RangeError);
  });
});

describe("createRedisSettlementCache", () => {
  it("returns undefined on a miss and the stored receipt on a hit", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });

    await expect(cache.get("nonce-1")).resolves.toBeUndefined();
    await cache.set("nonce-1", entry);

    const hit = await cache.get("nonce-1");
    expect(hit).toEqual(entry);
  });

  it("keeps serving a v1 entry written before the switch to v2, and round-trips a v2 entry", async () => {
    // Issue #166 migration window: one process wrote a v1 receipt; after the
    // switch, the same Redis holds v1 and v2 entries side by side and both
    // must parse, or a retry of the v1 payment would settle a second time.
    const client = new RedisMock() as unknown as RedisLikeClient;
    const beforeSwitch = createRedisSettlementCache({ client });
    const afterSwitch = createRedisSettlementCache({ client });
    await beforeSwitch.set("nonce-v1", entry);

    const signer = await Ed25519Signer.generate("cache-test-key-v2");
    const v2: SettlementEntry = {
      receipt: await signReceipt(
        buildReceipt({
          payer: "GPAYER",
          payee: "GPAYEE",
          amount: "10000",
          asset: "USDC:GA5Z",
          resource: "/quotes/latest",
          model: "x402",
          settlement: { kind: "transaction", txHash: "def456" },
          network: "testnet",
          offerHash: "A".repeat(43),
          method: "GET",
        }),
        signer,
      ),
      method: "GET",
    };
    await afterSwitch.set("nonce-v2", v2);

    await expect(afterSwitch.get("nonce-v1")).resolves.toEqual(entry);
    await expect(afterSwitch.get("nonce-v2")).resolves.toEqual(v2);
  });

  it("shares cached receipts across two cache instances pointing at the same Redis", async () => {
    // Two cache instances sharing one Redis backend stand in for two gate
    // processes serving the same nonce; this is the cross-instance idempotency
    // guarantee from issue #29.
    const client = new RedisMock() as unknown as RedisLikeClient;
    const writer = createRedisSettlementCache({ client });
    const reader = createRedisSettlementCache({ client });

    await writer.set("nonce-cross", entry);

    const hit = await reader.get("nonce-cross");
    expect(hit).toEqual(entry);
  });

  it("honors Redis TTL eviction semantics", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client, ttlMs: 1_000 });

    await cache.set("nonce-ttl", entry);
    await expect(cache.get("nonce-ttl")).resolves.toEqual(entry);

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
    await cache.set("nonce-good", entry);
    await expect(cache.get("nonce-good")).resolves.toEqual(entry);
  });

  it("reads a bare receipt from an older version as an entry with no method", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });
    await client.set("tollway:settlement:nonce-legacy", JSON.stringify(receipt), "EX", 30);
    await expect(cache.get("nonce-legacy")).resolves.toEqual({ receipt, method: null });
  });

  it("treats an entry with extra or malformed fields as a miss", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });
    for (const [key, value] of [
      ["nonce-extra", { receipt, method: "GET", note: "x" }],
      ["nonce-empty-method", { receipt, method: "" }],
      ["nonce-bad-receipt", { receipt: { hello: "world" }, method: "GET" }],
    ] as const) {
      await client.set(`tollway:settlement:${key}`, JSON.stringify(value), "EX", 30);
      await expect(cache.get(key)).resolves.toBeUndefined();
    }
  });

  it("applies a custom key prefix", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client, keyPrefix: "custom:" });
    await cache.set("nonce-prefix", entry);

    const direct = await client.get("custom:nonce-prefix");
    expect(direct).not.toBeNull();
    expect(JSON.parse(direct ?? "null")).toEqual(entry);
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
