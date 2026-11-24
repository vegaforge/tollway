/**
 * Detects duplicate settlements across processes from a settlement log.
 * Uses an in-process cache with configurable TTL to track settlement nonces
 * and commitment sequences, preventing double-settlement.
 */

export interface SettlementRecord {
  /** Authorization nonce for x402, commitment sequence for channel mode. */
  key: string;
  /** Model that settled (x402, mpp-charge, mpp-channel). */
  model: string;
  /** Timestamp when settlement was recorded. */
  at: number;
}

export interface DuplicateDetectorOptions {
  /** TTL in milliseconds for settlement records. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Maximum number of records to keep in memory. Defaults to 10000. */
  maxRecords?: number;
}

/**
 * In-process duplicate settlement detector. Tracks settlement nonces and
 * commitment sequences to prevent double-settlement within a time window.
 * For cross-process detection, use a persistent backend store.
 */
export function createDuplicateDetector(options: DuplicateDetectorOptions = {}) {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5 minutes
  const maxRecords = options.maxRecords ?? 10000;
  const records = new Map<string, SettlementRecord>();

  /** Cleanup expired records. Runs periodically to prevent unbounded growth. */
  function cleanup() {
    const now = Date.now();
    for (const [key, record] of records) {
      if (now - record.at > ttlMs) {
        records.delete(key);
      }
    }
  }

  /** Evict oldest records if at capacity. */
  function enforceCapacity() {
    if (records.size > maxRecords) {
      const sorted = Array.from(records.values()).sort((a, b) => a.at - b.at);
      const toRemove = sorted.slice(0, Math.ceil(maxRecords * 0.1)); // Remove 10%
      for (const record of toRemove) {
        records.delete(
          `${record.key}:${record.model}:${record.at}`,
        );
      }
    }
  }

  return {
    /**
     * Checks if a settlement key was already recorded. Returns true if duplicate,
     * false if new.
     */
    isDuplicate(key: string, model: string): boolean {
      cleanup();
      const recordKey = `${key}:${model}:*`;
      // Simple prefix check for the key and model combination
      for (const k of records.keys()) {
        if (k.startsWith(`${key}:${model}:`)) {
          return true;
        }
      }
      return false;
    },

    /**
     * Records a settlement to prevent duplicates. Returns true if recorded,
     * false if already present.
     */
    record(key: string, model: string): boolean {
      cleanup();
      const now = Date.now();
      const recordKey = `${key}:${model}:${now}`;

      // Check for existing record with this key and model
      for (const k of records.keys()) {
        if (k.startsWith(`${key}:${model}:`)) {
          return false; // Already recorded
        }
      }

      enforceCapacity();
      records.set(recordKey, { key, model, at: now });
      return true;
    },

    /** Get all current settlement records for inspection. */
    getRecords(): SettlementRecord[] {
      cleanup();
      return Array.from(records.values());
    },

    /** Clear all records (useful for testing). */
    clear(): void {
      records.clear();
    },
  };
}
