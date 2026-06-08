import type { SignedReceipt } from "@tollway/core";

/**
 * Short-lived idempotency cache keyed by settlement nonce. Facilitators are
 * known to be vulnerable to duplicate /settle submissions, so a repeat of
 * the same nonce returns the original receipt instead of charging twice.
 * See docs/design.md, "Design notes" (duplicate protection).
 */
export interface SettlementCache {
  get(nonce: string): SignedReceipt | undefined;
  set(nonce: string, receipt: SignedReceipt): void;
}

type Entry = { receipt: SignedReceipt; expiresAt: number };

/**
 * In-memory cache with time-based eviction. The default window is a few
 * Stellar ledger closes, long enough to absorb a retry storm and short
 * enough to stay small. Multi-process deployments should back this with a
 * shared store instead; the interface is the seam for that.
 */
export function createInMemorySettlementCache(ttlMs = 30_000): SettlementCache {
  const entries = new Map<string, Entry>();

  return {
    get(nonce) {
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
    set(nonce, receipt) {
      entries.set(nonce, { receipt, expiresAt: Date.now() + ttlMs });
    },
  };
}
