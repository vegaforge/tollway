import { parseStoredEntry, type SettlementEntry } from "./cache.js";

/**
 * The durable record of settled payments the gate replays from (#162). The
 * settlement cache is deliberately short-lived (30 s by default); once an
 * entry leaves it, a retry of a settled payment would otherwise go back to
 * `/verify`, where a spent authorization fails and the payer, who did pay,
 * gets no receipt. The gate looks a payment up here, before `/verify`, by the
 * same key the cache uses: `<model>:<nonce>`, where the nonce is derived from
 * the signed payment without the network.
 *
 * This interface is only the replay seam. The searchable archive in
 * `@vegaforge/tollway-observability` (#222) and a tamper-evident log (#171)
 * can implement it alongside their own interfaces.
 *
 * What a hit grants: whoever holds the exact signed payment bytes gets the
 * paid resource again, for the same offer and HTTP method, as the settlement
 * cache already allows. A hit for another offer or method is a 409, never a
 * replay. See docs/receipt-archive.md.
 */
export interface PaymentReceiptArchive {
  /** The settlement recorded under this payment key, or undefined. Throws when the store fails. */
  findByPaymentKey(key: string): Promise<SettlementEntry | undefined>;
  /** Records a settlement. Throws when the store fails; the gate reports it. */
  put(key: string, entry: SettlementEntry): Promise<void>;
}

export type InMemoryPaymentReceiptArchiveOptions = {
  /**
   * How long an entry is kept, in milliseconds. Unset means no expiry: an
   * entry stays until the size cap evicts it.
   */
  retentionMs?: number;
  /**
   * Most entries held at once; inserting past it evicts the oldest.
   * Defaults to 100 000, so a long-running process cannot grow without bound.
   */
  maxEntries?: number;
  /** Clock in milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
};

const DEFAULT_ARCHIVE_MAX_ENTRIES = 100_000;

/**
 * A process-local archive. It survives cache expiry but not a restart, and
 * other processes do not see it: use {@link createRedisPaymentReceiptArchive}
 * when more than one process serves the route.
 */
export function createInMemoryPaymentReceiptArchive(
  options: InMemoryPaymentReceiptArchiveOptions = {},
): PaymentReceiptArchive {
  const maxEntries = options.maxEntries ?? DEFAULT_ARCHIVE_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const { retentionMs } = options;
  if (retentionMs !== undefined && (!Number.isSafeInteger(retentionMs) || retentionMs < 1)) {
    throw new RangeError(`retentionMs must be a positive integer, got ${retentionMs}`);
  }
  const now = options.now ?? Date.now;
  // Insertion order is age order, so the first key is always the oldest.
  const entries = new Map<string, { entry: SettlementEntry; storedAt: number }>();

  return {
    async findByPaymentKey(key) {
      const stored = entries.get(key);
      if (!stored) return undefined;
      if (retentionMs !== undefined && now() - stored.storedAt >= retentionMs) {
        entries.delete(key);
        return undefined;
      }
      return stored.entry;
    },
    async put(key, entry) {
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { entry, storedAt: now() });
    },
  };
}

/**
 * The Redis surface the archive uses: a plain `SET` (no expiry), `SET ... PX`
 * for a retention, and `GET`. Any ioredis-compatible client fits, including
 * the one passed to `createRedisSettlementCache`.
 */
export interface RedisArchiveClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
}

export type RedisPaymentReceiptArchiveOptions = {
  client: RedisArchiveClient;
  /** Prefix for every key. Defaults to "tollway:archive:". */
  keyPrefix?: string;
  /**
   * How long an entry is kept, in milliseconds, as a Redis TTL. Unset means
   * no TTL: Redis keeps the entry until your eviction policy or a manual
   * cleanup removes it. See docs/receipt-archive.md for choosing one.
   */
  retentionMs?: number;
};

const DEFAULT_ARCHIVE_KEY_PREFIX = "tollway:archive:";

/**
 * A shared archive on Redis, so every process replays every settled payment.
 * Entries are `{ receipt, method }` as JSON and are checked against the
 * signed receipt schema when read: a corrupted or foreign value is a miss,
 * never a receipt (AGENTS.md item 1).
 */
export function createRedisPaymentReceiptArchive(
  options: RedisPaymentReceiptArchiveOptions,
): PaymentReceiptArchive {
  const { client, retentionMs } = options;
  const keyPrefix = options.keyPrefix ?? DEFAULT_ARCHIVE_KEY_PREFIX;
  if (retentionMs !== undefined && (!Number.isSafeInteger(retentionMs) || retentionMs < 1)) {
    throw new RangeError(`retentionMs must be a positive integer, got ${retentionMs}`);
  }

  return {
    async findByPaymentKey(key) {
      const raw = await client.get(`${keyPrefix}${key}`);
      if (raw === null) return undefined;
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw);
      } catch {
        // Not JSON, so not an entry this archive wrote: a miss, never a receipt.
        return undefined;
      }
      const entry = parseStoredEntry(candidate);
      // The archive only ever wrote `{ receipt, method }`. A bare receipt is
      // a legacy cache shape, not an archive entry, so it is a miss here.
      return entry && entry.method !== null ? entry : undefined;
    },
    async put(key, entry) {
      const value = JSON.stringify(entry);
      if (retentionMs === undefined) {
        await client.set(`${keyPrefix}${key}`, value);
      } else {
        await client.set(`${keyPrefix}${key}`, value, "PX", retentionMs);
      }
    },
  };
}
