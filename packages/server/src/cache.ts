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
 * a process. `acquire`, `renew` and `release` extend that across processes. A
 * cache that does not implement them still works, but two processes can then
 * both settle the same payment if it reaches them at the same moment.
 */
export interface SettlementCache {
  get(key: string): Promise<SignedReceipt | undefined>;
  set(key: string, receipt: SignedReceipt): Promise<void>;
  /**
   * Takes an exclusive settlement lock on `key` for `ttlMs`. Resolves the
   * lock on success, or false if another holder has it.
   */
  acquire?(key: string, ttlMs: number): Promise<SettlementLock | false>;
  /**
   * Extends a lock taken with `acquire` by `ttlMs`. Resolves false, and
   * changes nothing, if the caller no longer holds it.
   */
  renew?(key: string, lock: SettlementLock, ttlMs: number): Promise<boolean>;
  /**
   * Releases a lock taken with `acquire`. Resolves false, and changes
   * nothing, if the caller no longer holds it: a lock that expired may
   * already belong to another process.
   */
  release?(key: string, lock: SettlementLock): Promise<boolean>;
}

/**
 * Proof of holding a settlement lock. The token is unique per acquisition,
 * so a holder whose lock expired cannot renew or release the next holder's.
 */
export type SettlementLock = { readonly token: string };

/** A settlement cache that also provides the cross-process lock. */
export type LockingSettlementCache = SettlementCache &
  Required<Pick<SettlementCache, "acquire" | "renew" | "release">>;

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
 * or null, and `eval(script, numKeys, ...keysAndArgs)` runs a Lua script
 * atomically, which is how a lock is renewed or released only by its holder.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<unknown>;
  eval(script: string, numKeys: number, ...keysAndArgs: Array<string | number>): Promise<unknown>;
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

// Both scripts compare the stored token with the caller's before acting, in
// one atomic step. A GET followed by a separate DEL or PEXPIRE could act on a
// lock that changed hands between the two calls.
const RELEASE_IF_HELD = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

const RENEW_IF_HELD = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

function lockMs(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs));
}
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
 * `acquire` is `SET NX PX` with a random token as the value, so only one
 * process at a time settles a given payment. `renew` and `release` compare
 * that token and act in one Lua script, so a process whose lock expired can
 * never extend or delete the lock another process now holds. The lock TTL is
 * the bound if a holder dies without releasing.
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
      const token = crypto.randomUUID();
      const result = await client.set(
        `${keyPrefix}lock:${key}`,
        token,
        "PX",
        lockMs(lockTtlMs),
        "NX",
      );
      return result === "OK" ? { token } : false;
    },
    async renew(key, lock, lockTtlMs) {
      const result = await client.eval(
        RENEW_IF_HELD,
        1,
        `${keyPrefix}lock:${key}`,
        lock.token,
        lockMs(lockTtlMs),
      );
      return result === 1;
    },
    async release(key, lock) {
      const result = await client.eval(RELEASE_IF_HELD, 1, `${keyPrefix}lock:${key}`, lock.token);
      return result === 1;
    },
  };
}
