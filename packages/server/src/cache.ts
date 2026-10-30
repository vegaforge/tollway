import { type SignedReceipt, signedReceiptSchema } from "@tollway/core";

/**
 * Short-lived idempotency cache keyed by settlement model and nonce
 * (`<model>:<nonce>`). Facilitators are known to be vulnerable to duplicate
 * /settle submissions, so a repeat of the same payment returns the original
 * receipt instead of charging twice. The gate only returns a cached receipt
 * when it matches the offer being served. See docs/design.md, "Design notes"
 * (duplicate protection).
 *
 * The interface is async so a single seam covers both the in-memory cache
 * used in a single-process deployment and a shared-store backend (Redis,
 * etc.) used when the gate runs in multiple processes.
 *
 * The gate always deduplicates concurrent settlements of one payment inside
 * a process. `acquire` and `release` extend that across processes. A cache
 * that does not implement them still works, but two processes can then both
 * settle the same payment if it reaches them at the same moment.
 */
export interface SettlementCache {
  get(key: string): Promise<SignedReceipt | undefined>;
  set(key: string, receipt: SignedReceipt): Promise<void>;
  /** Takes an exclusive settlement lock on `key`. Resolves false if another holder has it. */
  acquire?(key: string, ttlMs: number): Promise<boolean>;
  /** Releases a lock taken with `acquire`. */
  release?(key: string): Promise<void>;
}

/** A settlement cache that also provides the cross-process lock. */
export type LockingSettlementCache = SettlementCache &
  Required<Pick<SettlementCache, "acquire" | "release">>;

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
    async get(key) {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.receipt;
    },
    async set(key, receipt) {
      entries.set(key, { receipt, expiresAt: Date.now() + ttlMs });
    },
  };
}

/**
 * The minimal Redis surface this cache uses, kept duck-typed so consumers
 * can plug in `ioredis`, `ioredis-mock`, or any compatible client without
 * @tollway/server taking on a runtime dependency. The methods match the
 * ioredis signatures used here: `set(key, value, "EX", ttlSeconds)` stores
 * with a TTL, `set(key, value, "PX", ttlMs, "NX")` stores only if the key is
 * absent and resolves "OK" when it did, `get(key)` returns the stored value
 * or null, and `del(key)` removes a key.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export type RedisSettlementCacheOptions = {
  /** Connected ioredis-compatible client. */
  client: RedisLikeClient;
  /** Cache TTL. Defaults to 30s to match the in-memory cache. */
  ttlMs?: number;
  /**
   * Prefix applied to every key. Defaults to "tollway:settlement:". Locks
   * live under the same prefix followed by "lock:".
   */
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
 *
 * `acquire` is `SET NX PX`, so only one process at a time settles a given
 * payment. `release` deletes the lock without checking who holds it; the
 * lock TTL is the bound if a holder dies before releasing.
 */
export function createRedisSettlementCache(
  options: RedisSettlementCacheOptions,
): LockingSettlementCache {
  const { client } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_REDIS_TTL_MS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

  return {
    async get(key) {
      const raw = await client.get(`${keyPrefix}${key}`);
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
    async set(key, receipt) {
      await client.set(`${keyPrefix}${key}`, JSON.stringify(receipt), "EX", ttlSeconds);
    },
    async acquire(key, lockTtlMs) {
      const result = await client.set(
        `${keyPrefix}lock:${key}`,
        "1",
        "PX",
        Math.max(1, Math.ceil(lockTtlMs)),
        "NX",
      );
      return result === "OK";
    },
    async release(key) {
      await client.del(`${keyPrefix}lock:${key}`);
    },
  };
}
