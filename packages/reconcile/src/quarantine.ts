import type { CounterpartyQuarantine, QuarantineEntry } from "@vegaforge/tollway-core";
import type { Drift, DriftKind, ReconciliationResult } from "./index.js";

/** Action taken when a drift kind is observed in a reconciliation result. */
export type DriftAction = "quarantine" | "warn" | "ignore";

/**
 * Conservative defaults: proven counterparty cheating (`under-settled`,
 * `recipient-mismatch`, `token-mismatch`) quarantines; other proven drift
 * kinds warn. Unknown or transient/unverifiable outcomes never quarantine.
 */
export const DEFAULT_DRIFT_ACTIONS: Record<DriftKind, DriftAction> & Record<string, DriftAction> = {
  "under-settled": "quarantine",
  "over-settled": "warn",
  "missing-commitment": "warn",
  "unexpected-remainder": "warn",
  "sequence-gap": "warn",
  "malformed-record": "warn",
  "non-monotonic-cumulative": "warn",
  "foreign-commitment": "warn",
  "duplicate-sequence": "warn",
  "recipient-mismatch": "quarantine",
  "token-mismatch": "quarantine",
};

export type DriftWarnEvent = {
  counterparty: string;
  channelId: string;
  drift: Drift;
};

export type DriftQuarantineEvent = {
  counterparty: string;
  channelId: string;
  drift: Drift;
  entry: QuarantineEntry;
};

export type QuarantineEnforcerOptions = {
  quarantine: CounterpartyQuarantine;
  /** Override the default drift-kind-to-action mapping. */
  actions?: Partial<Record<DriftKind | (string & {}), DriftAction>>;
  /** Called once per drift kind configured with `"warn"`. */
  onWarn?: (event: DriftWarnEvent) => void;
  /** Called once per drift kind configured with `"quarantine"`. */
  onQuarantine?: (event: DriftQuarantineEvent) => void;
  /**
   * How many processed result keys to remember for deduplication. The oldest
   * key is forgotten first once the limit is reached, so memory stays bounded
   * in a long-running process. Reprocessing a forgotten result runs its
   * actions again; quarantining is idempotent for an active entry, so the
   * cost is a repeated `onWarn` or `onQuarantine` call. Defaults to 10000.
   */
  maxRememberedResults?: number;
};

const DEFAULT_MAX_REMEMBERED_RESULTS = 10_000;

export type ProcessReconciliationInput = {
  counterparty: string;
  result: ReconciliationResult;
  /**
   * Optional deduplication key for this result. Defaults to a deterministic
   * key derived from `counterparty`, `result.channelId`, and the drift list.
   */
  resultKey?: string;
};

export type ProcessedDriftAction = {
  drift: Drift;
  action: DriftAction;
  quarantined: boolean;
};

export type ProcessReconciliationOutput = {
  /** True when this exact result was already processed and skipped. */
  duplicate: boolean;
  actions: ProcessedDriftAction[];
};

export interface ReconciliationQuarantineEnforcer {
  process(input: ProcessReconciliationInput): Promise<ProcessReconciliationOutput>;
}

function defaultResultKey(counterparty: string, result: ReconciliationResult): string {
  if (result.ok) return `${counterparty}:${result.channelId}:ok`;
  return `${counterparty}:${result.channelId}:${JSON.stringify(result.drift)}`;
}

/**
 * Turns `ReconciliationResult` outputs into `CounterpartyQuarantine` actions
 * according to a configurable drift-kind-to-action mapping. Each drift kind
 * triggers its configured action at most once per result, even when the same
 * result is processed multiple times.
 */
export function createQuarantineEnforcer(
  options: QuarantineEnforcerOptions,
): ReconciliationQuarantineEnforcer {
  const { quarantine, actions: overrides, onWarn, onQuarantine } = options;
  const maxRemembered = options.maxRememberedResults ?? DEFAULT_MAX_REMEMBERED_RESULTS;
  if (!Number.isSafeInteger(maxRemembered) || maxRemembered < 1) {
    throw new TypeError(
      `maxRememberedResults must be a positive integer, got ${String(options.maxRememberedResults)}`,
    );
  }
  // A Set iterates in insertion order, so its first key is the oldest.
  const processedKeys = new Set<string>();

  function remember(key: string): void {
    processedKeys.add(key);
    while (processedKeys.size > maxRemembered) {
      const oldest = processedKeys.values().next().value;
      if (oldest === undefined) break;
      processedKeys.delete(oldest);
    }
  }

  function resolveAction(kind: string): DriftAction {
    if (overrides && Object.hasOwn(overrides, kind)) {
      const configured = overrides[kind];
      if (configured !== undefined) return configured;
    }
    if (Object.hasOwn(DEFAULT_DRIFT_ACTIONS, kind)) {
      return DEFAULT_DRIFT_ACTIONS[kind] ?? "ignore";
    }
    return "ignore";
  }

  return {
    async process(input: ProcessReconciliationInput): Promise<ProcessReconciliationOutput> {
      const { counterparty, result } = input;
      if (result.ok) {
        return { duplicate: false, actions: [] };
      }

      const key = input.resultKey ?? defaultResultKey(counterparty, result);
      if (processedKeys.has(key)) {
        return { duplicate: true, actions: [] };
      }

      // Deduplicate by drift kind within one result so each drift kind triggers
      // its configured action once per result.
      const seenKinds = new Set<string>();
      const uniqueDrifts: Drift[] = [];
      for (const drift of result.drift) {
        if (!seenKinds.has(drift.kind)) {
          seenKinds.add(drift.kind);
          uniqueDrifts.push(drift);
        }
      }

      const actions: ProcessedDriftAction[] = [];

      for (const drift of uniqueDrifts) {
        const action = resolveAction(drift.kind);
        if (action === "quarantine") {
          const entry = await quarantine.quarantine({
            counterparty,
            reason: `reconciliation drift (${drift.kind}): ${drift.detail}`,
            drift: {
              kind: drift.kind,
              detail: drift.detail,
              channelId: result.channelId,
            },
          });
          onQuarantine?.({ counterparty, channelId: result.channelId, drift, entry });
          actions.push({ drift, action, quarantined: true });
        } else if (action === "warn") {
          onWarn?.({ counterparty, channelId: result.channelId, drift });
          actions.push({ drift, action, quarantined: false });
        } else {
          actions.push({ drift, action, quarantined: false });
        }
      }

      remember(key);
      return { duplicate: false, actions };
    },
  };
}
