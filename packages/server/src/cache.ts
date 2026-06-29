import { type SignedReceipt, signedReceiptSchema } from "@tollway/core";

/**
 * Short-lived idempotency cache keyed by settlement nonce. Facilitators are
 * known to be vulnerable to duplicate /settle submissions, so a repeat of
 * the same nonce returns the original receipt instead of charging twice.
 * See docs/design.md, "Design notes" (duplicate protection).
 *
 * The interface is async so a single seam covers both the in-memory cache
 * used in a single-process deployment and a shared-store backend (Redis,
 * etc.) used when the gate runs in multiple processes.
 */
export interface SettlementCache {
  get(nonce: string): Promise<SignedReceipt | undefined>;
  set(nonce: string, receipt: SignedReceipt): Promise<void>;
}

type Entry = { receipt: SignedReceipt; expiresAt: number };

/**
 * In-memory cache with TTL eviction. The default window covers a few ledger
 * closes, enough to absorb a retry. Back it with a shared store
 * (createRedisSettlementCache) for multi-process deployments; the interface
 * is the seam.
 */
export function createInMemorySettlementCache(ttlMs = 30_000): SettlementCache {
  const entries = new Map<string, Entry>();

  return {
    async get(nonce) {
      const entry = entries.get(nonce);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= Date.now()) {
        entries.delete(nonce);
        return undefined;
      }
      return entry.receipt;
    },
    async set(nonce, receipt) {
      entries.set(nonce, { receipt, expiresAt: Date.now() + ttlMs });
    },
  };
}

/**
 * The minimal Redis surface this cache uses, kept duck-typed so consumers
 * can plug in `ioredis`, `ioredis-mock`, or any compatible client without
 * @tollway/server taking on a runtime dependency. The two methods match
 * the ioredis signatures used here: `set(key, value, "EX", ttlSeconds)`
 * stores with a TTL, and `get(key)` returns the stored value or null.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export type RedisSettlementCacheOptions = {
  /** Connected ioredis-compatible client. */
  client: RedisLikeClient;
  /** Cache TTL. Defaults to 30s to match the in-memory cache. */
  ttlMs?: number;
  /** Prefix applied to every nonce key. Defaults to "tollway:settlement:". */
  keyPrefix?: string;
};

const DEFAULT_REDIS_TTL_MS = 30_000;
const DEFAULT_REDIS_KEY_PREFIX = "tollway:settlement:";

/**
 * Shared-store settlement cache backed by a Redis-compatible client. Two or
 * more gate processes pointing at the same Redis see the same cached
 * receipts, which is what makes the duplicate-protection guarantee from
 * docs/design.md hold across a horizontally scaled deployment.
 *
 * TTL is expressed in seconds via Redis's `EX` option so the store evicts
 * stale entries itself, matching the in-memory cache's eviction window.
 * Receipts round-trip as JSON; the structure is the canonical SignedReceipt
 * from @tollway/core, so deserialization is a plain `JSON.parse`.
 *
 * The client is injected so the consumer owns the connection lifecycle, and
 * @tollway/server stays free of a hard dependency on `ioredis`. Tests use
 * `ioredis-mock` against the same interface.
 */
export function createRedisSettlementCache(options: RedisSettlementCacheOptions): SettlementCache {
  const { client } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_REDIS_TTL_MS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

  return {
    async get(nonce) {
      const raw = await client.get(`${keyPrefix}${nonce}`);
      if (raw === null) {
        return undefined;
      }
      // A shared store can hold corrupted or foreign entries (a key collision
      // with another tenant, a manual write, a partial deploy). Treat any
      // value that does not round-trip as a canonical SignedReceipt as a miss
      // rather than letting it break the settlement.
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw);
      } catch {
        return undefined;
      }
      const parsed = signedReceiptSchema.safeParse(candidate);
      return parsed.success ? (parsed.data as SignedReceipt) : undefined;
    },
    async set(nonce, receipt) {
      await client.set(`${keyPrefix}${nonce}`, JSON.stringify(receipt), "EX", ttlSeconds);
    },
  };
}
