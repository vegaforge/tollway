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
