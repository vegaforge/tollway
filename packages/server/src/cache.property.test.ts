import {
  buildReceipt,
  Ed25519Signer,
  signedReceiptSchema,
  signReceipt,
} from "@vegaforge/tollway-core";
import fc from "fast-check";
import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { createRedisSettlementCache, type RedisLikeClient, type SettlementEntry } from "./cache.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

const KEY = "property-nonce";
const STORED_KEY = "tollway:settlement:property-nonce";

const signer = await Ed25519Signer.generate("cache-property-key");
const receipt = await signReceipt(
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

describe("createRedisSettlementCache boundary properties", () => {
  it("never rejects or returns a non-receipt for arbitrary stored strings", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });

    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (raw) => {
        await redis.set(STORED_KEY, raw);

        let hit: SettlementEntry | undefined;
        try {
          hit = await cache.get(KEY);
        } catch (error) {
          expect.fail(`cache.get rejected for stored text: ${String(error)}`);
        }
        if (hit === undefined) {
          return true;
        }
        expect(signedReceiptSchema.safeParse(hit.receipt).success).toBe(true);
        expect(hit.method === null || typeof hit.method === "string").toBe(true);
        return true;
      }),
      ASSERT_OPTS,
    );
  });

  it("returns a schema-valid receipt for every non-empty method written by the cache", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const cache = createRedisSettlementCache({ client });

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 16 }), async (method) => {
        const entry: SettlementEntry = { receipt, method };
        await cache.set(KEY, entry);

        const hit = await cache.get(KEY);
        expect(hit).toEqual(entry);
        expect(signedReceiptSchema.safeParse(hit?.receipt).success).toBe(true);
      }),
      ASSERT_OPTS,
    );
  });
});
