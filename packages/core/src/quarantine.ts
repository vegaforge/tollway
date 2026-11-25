import { TollwayError } from "./errors.js";

/**
 * Proven drift details recorded on a quarantine entry. Mirrors the shape of
 * `@vegaforge/tollway-reconcile`'s `Drift` without introducing a dependency
 * from `core` on `reconcile`.
 */
export type QuarantineDrift = {
  kind: string;
  detail: string;
  channelId?: string;
};

/**
 * One quarantine record for a counterparty, including explicit release audit
 * fields (`releasedBy` and `releasedAt`) when lifted.
 */
export type QuarantineEntry = {
  counterparty: string;
  reason: string;
  drift: QuarantineDrift;
  quarantinedAt: string;
  releasedBy?: string;
  releasedAt?: string;
};

export type QuarantineInput = {
  counterparty: string;
  reason: string;
  drift: QuarantineDrift;
};

export type ReleaseQuarantineInput = {
  counterparty: string;
  releasedBy: string;
};

/**
 * Tracks counterparties that have been quarantined due to proven reconciliation
 * drift. See docs/design.md, "Reconciliation".
 */
export interface CounterpartyQuarantine {
  quarantine(input: QuarantineInput): Promise<QuarantineEntry>;
  release(input: ReleaseQuarantineInput): Promise<QuarantineEntry | undefined>;
  /**
   * Returns the active quarantine entry for `counterparty`, or `undefined` if
   * not currently quarantined.
   */
  lookup(counterparty: string): Promise<QuarantineEntry | undefined>;
  /**
   * Returns all recorded entries (active and released) for `counterparty`, or
   * across all counterparties when omitted.
   */
  history(counterparty?: string): Promise<readonly QuarantineEntry[]>;
}

export type CreateMemoryQuarantineOptions = {
  /**
   * Optional automatic release duration in milliseconds. Defaults to
   * `undefined` (manual release only).
   */
  autoReleaseAfterMs?: number;
  /**
   * Clock function returning the current time as an ISO-8601 string. Defaults
   * to `() => new Date().toISOString()`.
   */
  now?: () => string;
};

/**
 * In-memory `CounterpartyQuarantine` with audited manual release by default.
 */
export function createMemoryQuarantine(
  options: CreateMemoryQuarantineOptions = {},
): CounterpartyQuarantine {
  const { autoReleaseAfterMs, now = () => new Date().toISOString() } = options;

  if (
    autoReleaseAfterMs !== undefined &&
    (!Number.isFinite(autoReleaseAfterMs) || autoReleaseAfterMs <= 0)
  ) {
    throw new TollwayError(
      "invalid-policy",
      `autoReleaseAfterMs must be a positive finite number, got ${String(autoReleaseAfterMs)}`,
    );
  }

  const active = new Map<string, QuarantineEntry>();
  const auditLog: QuarantineEntry[] = [];

  function maybeExpire(counterparty: string): QuarantineEntry | undefined {
    const entry = active.get(counterparty);
    if (!entry) return undefined;

    if (autoReleaseAfterMs !== undefined) {
      const quarantinedMs = Date.parse(entry.quarantinedAt);
      const currentIso = now();
      const currentMs = Date.parse(currentIso);
      if (
        Number.isFinite(quarantinedMs) &&
        Number.isFinite(currentMs) &&
        currentMs - quarantinedMs >= autoReleaseAfterMs
      ) {
        entry.releasedBy = "auto-expiry";
        entry.releasedAt = currentIso;
        active.delete(counterparty);
        return undefined;
      }
    }

    return entry;
  }

  return {
    async quarantine(input: QuarantineInput): Promise<QuarantineEntry> {
      if (!input.counterparty.trim()) {
        throw new TollwayError("invalid-policy", "quarantine counterparty must not be empty");
      }
      const existing = maybeExpire(input.counterparty);
      if (existing) {
        return { ...existing, drift: { ...existing.drift } };
      }

      const entry: QuarantineEntry = {
        counterparty: input.counterparty,
        reason: input.reason,
        drift: { ...input.drift },
        quarantinedAt: now(),
      };
      active.set(input.counterparty, entry);
      auditLog.push(entry);
      return { ...entry, drift: { ...entry.drift } };
    },

    async release(input: ReleaseQuarantineInput): Promise<QuarantineEntry | undefined> {
      if (!input.releasedBy.trim()) {
        throw new TollwayError("invalid-policy", "release requires a non-empty releasedBy");
      }
      const entry = maybeExpire(input.counterparty);
      if (!entry) return undefined;

      entry.releasedBy = input.releasedBy;
      entry.releasedAt = now();
      active.delete(input.counterparty);
      return { ...entry, drift: { ...entry.drift } };
    },

    async lookup(counterparty: string): Promise<QuarantineEntry | undefined> {
      const entry = maybeExpire(counterparty);
      if (!entry) return undefined;
      return { ...entry, drift: { ...entry.drift } };
    },

    async history(counterparty?: string): Promise<readonly QuarantineEntry[]> {
      if (counterparty !== undefined) {
        maybeExpire(counterparty);
        return auditLog
          .filter((entry) => entry.counterparty === counterparty)
          .map((entry) => ({ ...entry, drift: { ...entry.drift } }));
      }
      for (const key of active.keys()) {
        maybeExpire(key);
      }
      return auditLog.map((entry) => ({ ...entry, drift: { ...entry.drift } }));
    },
  };
}
