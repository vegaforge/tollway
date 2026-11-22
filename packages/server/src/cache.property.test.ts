import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  buildReceipt,
  Ed25519Signer,
  signedReceiptSchema,
  signReceipt,
} from "@vegaforge/tollway-core";
import fc from "fast-check";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it } from "vitest";
import { createRedisSettlementCache, type RedisLikeClient, type SettlementEntry } from "./cache.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

const KEY = "property-nonce";

/** ioredis-mock shares data per host, so each test gets its own prefix. */
function cacheWithPrefix(keyPrefix: string) {
  const redis = new RedisMock();
  const cache = createRedisSettlementCache({
    client: redis as unknown as RedisLikeClient,
    keyPrefix,
  });
  return { redis, cache, storedKey: `${keyPrefix}${KEY}` };
}

let receipt: SignedReceipt;
beforeAll(async () => {
  const signer = await Ed25519Signer.generate("cache-property-key");
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

/**
 * What the cache must return for a stored value, written from the documented
 * entry format rather than from parseStoredEntry: exactly `receipt` and a
 * non-empty string `method`, or a bare receipt an older version wrote.
 */
function expectedEntry(stored: unknown): SettlementEntry | undefined {
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    const keys = Object.keys(stored).sort();
    if (keys.length === 2 && keys[0] === "method" && keys[1] === "receipt") {
      const { receipt: candidate, method } = stored as { receipt: unknown; method: unknown };
      const parsed = signedReceiptSchema.safeParse(candidate);
      return parsed.success && typeof method === "string" && method !== ""
        ? { receipt: parsed.data, method }
        : undefined;
    }
  }
  const legacy = signedReceiptSchema.safeParse(stored);
  return legacy.success ? { receipt: legacy.data, method: null } : undefined;
}

/** Replaces the value at one path of a JSON object. */
function setPath(value: unknown, path: readonly string[], replacement: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (typeof value !== "object" || value === null) return value;
  const current = (value as Record<string, unknown>)[head];
  return { ...value, [head]: setPath(current, rest, replacement) };
}

// Paths inside a stored entry. A SignedReceipt is `{ receipt, signature }`,
// so the receipt body sits one level further in.
const RECEIPT_PATHS: readonly (readonly string[])[] = [
  ["receipt", "receipt", "version"],
  ["receipt", "receipt", "amount"],
  ["receipt", "receipt", "payee"],
  ["receipt", "receipt", "model"],
  ["receipt", "receipt", "settlement"],
  ["receipt", "receipt", "settlement", "kind"],
  ["receipt", "receipt", "settlement", "txHash"],
  ["receipt", "signature"],
  ["receipt", "signature", "algorithm"],
];

/** Stored values close to a real entry: the inputs that reach the schema checks. */
function nearEntryArb(): fc.Arbitrary<unknown> {
  const anyJson = fc.jsonValue({ stringUnit: "binary", maxDepth: 2 });
  return fc.oneof(
    // A valid entry, as the cache writes it.
    fc
      .string({ unit: "binary", minLength: 1, maxLength: 8 })
      .map((method) => ({ receipt, method })),
    // A method that is empty, not a string, or missing.
    fc
      .oneof(fc.constant(""), anyJson)
      .filter((method) => typeof method !== "string" || method === "")
      .map((method) => ({ receipt, method })),
    fc.constant({ receipt }),
    // An extra key next to a valid entry.
    fc
      .tuple(fc.string({ minLength: 1, maxLength: 8 }), anyJson)
      .filter(([key]) => key !== "receipt" && key !== "method")
      .map(([key, extra]) => ({ receipt, method: "GET", [key]: extra })),
    // One receipt field replaced with arbitrary JSON.
    fc
      .tuple(fc.constantFrom(...RECEIPT_PATHS), anyJson)
      .map(([path, replacement]) => setPath({ receipt, method: "GET" }, path, replacement)),
    // A bare receipt an older version stored, intact or with a field replaced.
    fc.constant<unknown>(receipt),
    fc
      .tuple(fc.constantFrom(...RECEIPT_PATHS), anyJson)
      .map(([path, replacement]) => setPath({ receipt }, path, replacement))
      .map((wrapped) => (wrapped as { receipt: unknown }).receipt),
  );
}

describe("createRedisSettlementCache boundary properties", () => {
  it("never rejects or returns a non-receipt for arbitrary stored strings", async () => {
    const { redis, cache, storedKey } = cacheWithPrefix("property:strings:");

    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary", maxLength: 200 }), async (raw) => {
        await redis.set(storedKey, raw);

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
        expect(hit.method === null || (typeof hit.method === "string" && hit.method !== "")).toBe(
          true,
        );
        return true;
      }),
      ASSERT_OPTS,
    );
  });

  it("returns exactly the documented entry for stored values close to a real one", async () => {
    const { redis, cache, storedKey } = cacheWithPrefix("property:near:");

    await fc.assert(
      fc.asyncProperty(nearEntryArb(), async (stored) => {
        const text = JSON.stringify(stored);
        await redis.set(storedKey, text);
        // The oracle reads the same JSON text the cache reads.
        expect(await cache.get(KEY)).toEqual(expectedEntry(JSON.parse(text)));
      }),
      ASSERT_OPTS,
    );
  });

  it("returns a schema-valid receipt for every non-empty method written by the cache", async () => {
    const { cache } = cacheWithPrefix("property:written:");

    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "binary", minLength: 1, maxLength: 16 }),
        async (method) => {
          const entry: SettlementEntry = { receipt, method };
          await cache.set(KEY, entry);
          expect(await cache.get(KEY)).toEqual(entry);
        },
      ),
      ASSERT_OPTS,
    );
  });
});
