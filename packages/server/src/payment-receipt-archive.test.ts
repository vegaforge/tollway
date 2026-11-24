import {
  buildReceipt,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemoryPaymentReceiptArchive,
  createRedisPaymentReceiptArchive,
  type RedisArchiveClient,
} from "./payment-receipt-archive.js";

/** Issue #162: the stores behind the replay archive. */

let receipt: SignedReceipt;
beforeAll(async () => {
  const signer = await Ed25519Signer.generate("archive");
  receipt = await signReceipt(
    buildReceipt({
      payer: "GPAYER",
      payee: "GPAYEE",
      amount: "10000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      resource: "/quotes/latest",
      model: "x402",
      settlement: { kind: "transaction", txHash: "ab".repeat(32) },
      network: "testnet",
    }),
    signer,
  );
});

describe("createInMemoryPaymentReceiptArchive", () => {
  it("returns what was put under a payment key, and nothing for another key", async () => {
    const archive = createInMemoryPaymentReceiptArchive();
    await archive.put("x402:key", { receipt, method: "GET" });
    expect(await archive.findByPaymentKey("x402:key")).toEqual({ receipt, method: "GET" });
    expect(await archive.findByPaymentKey("x402:other")).toBeUndefined();
  });

  it("keeps entries with no expiry by default", async () => {
    let now = 0;
    const archive = createInMemoryPaymentReceiptArchive({ now: () => now });
    await archive.put("x402:key", { receipt, method: "GET" });
    now = 365 * 24 * 60 * 60 * 1000;
    expect(await archive.findByPaymentKey("x402:key")).toBeDefined();
  });

  it("drops entries older than the configured retention", async () => {
    let now = 0;
    const archive = createInMemoryPaymentReceiptArchive({ retentionMs: 1_000, now: () => now });
    await archive.put("x402:key", { receipt, method: "GET" });
    now = 999;
    expect(await archive.findByPaymentKey("x402:key")).toBeDefined();
    now = 1_000;
    expect(await archive.findByPaymentKey("x402:key")).toBeUndefined();
  });

  it("evicts the oldest entry at its size cap", async () => {
    const archive = createInMemoryPaymentReceiptArchive({ maxEntries: 2 });
    await archive.put("a", { receipt, method: "GET" });
    await archive.put("b", { receipt, method: "GET" });
    await archive.put("c", { receipt, method: "GET" });
    expect(await archive.findByPaymentKey("a")).toBeUndefined();
    expect(await archive.findByPaymentKey("c")).toBeDefined();
  });

  it("refuses a bad size cap or retention", () => {
    expect(() => createInMemoryPaymentReceiptArchive({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => createInMemoryPaymentReceiptArchive({ retentionMs: 0 })).toThrow(RangeError);
  });
});

describe("createRedisPaymentReceiptArchive", () => {
  function redis(): RedisArchiveClient & { ttl(key: string): Promise<number> } {
    return new RedisMock() as unknown as RedisArchiveClient & { ttl(key: string): Promise<number> };
  }

  it("stores with no TTL by default", async () => {
    const client = redis();
    const archive = createRedisPaymentReceiptArchive({ client, keyPrefix: "archive-test:a:" });
    await archive.put("x402:key", { receipt, method: "GET" });
    expect(await archive.findByPaymentKey("x402:key")).toEqual({ receipt, method: "GET" });
    expect(await client.ttl("archive-test:a:x402:key")).toBe(-1);
  });

  it("applies the configured retention as a TTL", async () => {
    const client = redis();
    const archive = createRedisPaymentReceiptArchive({
      client,
      keyPrefix: "archive-test:b:",
      retentionMs: 86_400_000,
    });
    await archive.put("x402:key", { receipt, method: "GET" });
    const ttl = await client.ttl("archive-test:b:x402:key");
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it("schema-validates what it reads: a corrupted or foreign entry is a miss", async () => {
    const client = redis();
    const archive = createRedisPaymentReceiptArchive({ client, keyPrefix: "archive-test:c:" });
    await client.set("archive-test:c:x402:garbage", "{not json");
    await client.set(
      "archive-test:c:x402:foreign",
      JSON.stringify({ receipt: { tampered: true }, method: "GET" }),
    );
    await client.set(
      "archive-test:c:x402:extra",
      JSON.stringify({ receipt, method: "GET", injected: "field" }),
    );
    expect(await archive.findByPaymentKey("x402:garbage")).toBeUndefined();
    expect(await archive.findByPaymentKey("x402:foreign")).toBeUndefined();
    expect(await archive.findByPaymentKey("x402:extra")).toBeUndefined();
  });

  it("propagates a store failure so the gate can report it", async () => {
    const failure = new Error("redis down");
    const client: RedisArchiveClient = {
      get: vi.fn(async () => {
        throw failure;
      }),
      set: vi.fn(async () => "OK"),
    };
    const archive = createRedisPaymentReceiptArchive({ client });
    await expect(archive.findByPaymentKey("x402:key")).rejects.toBe(failure);
  });
});
