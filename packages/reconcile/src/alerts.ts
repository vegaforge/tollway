import type { Drift, DriftKind, ReconciliationResult } from "./index.js";
import { type DriftSeverity, resolveDriftSeverity } from "./report.js";

export type DriftAlertPayload = {
  source: "reconcile";
  subject: string;
  kind: DriftKind;
  detail: string;
  severity: DriftSeverity;
};

export type AlertEventInput = {
  id?: string;
  type: "anomaly.detected";
  at: string;
  data: DriftAlertPayload;
};

export type AlertDeliveryReport = {
  failures: ReadonlyArray<{
    error: Error;
  }>;
};

/**
 * Minimal structural interface matching `@vegaforge/tollway-observability`'s
 * `ObservabilityHub.emit` without introducing a cross-package dependency.
 */
export type AlertEmitter = {
  emit(event: AlertEventInput): Promise<AlertDeliveryReport>;
};

/**
 * Persistence seam for active drift state per subject. Implement against a
 * durable store (such as #213's result store) to deduplicate alerts across
 * process restarts.
 */
export interface DriftAlertStore {
  getActive(
    subject: string,
  ): Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
  setActive(subject: string, active: Record<string, string>): Promise<void> | void;
}

function groupDriftsByKind(drifts: readonly Drift[]): Record<string, string> {
  const grouped = new Map<DriftKind, string[]>();
  for (const d of drifts) {
    const list = grouped.get(d.kind);
    if (list) {
      list.push(d.detail);
    } else {
      grouped.set(d.kind, [d.detail]);
    }
  }
  const record: Record<string, string> = {};
  for (const [kind, details] of grouped) {
    record[kind] = details.join("\n");
  }
  return record;
}

/**
 * In-memory `DriftAlertStore`. Optionally pass previously persisted
 * `ReconciliationResult` entries to seed deduplication state after a restart.
 */
export function createMemoryDriftAlertStore(
  initialResults: readonly ReconciliationResult[] = [],
): DriftAlertStore {
  const state = new Map<string, Record<string, string>>();

  for (const result of initialResults) {
    if (result.ok) {
      state.delete(result.channelId);
    } else {
      state.set(result.channelId, groupDriftsByKind(result.drift));
    }
  }

  return {
    getActive(subject) {
      const entry = state.get(subject);
      return entry ? { ...entry } : undefined;
    },
    setActive(subject, active) {
      if (Object.keys(active).length === 0) {
        state.delete(subject);
      } else {
        state.set(subject, { ...active });
      }
    },
  };
}

export type DriftAlertBridgeOptions = {
  emitter: AlertEmitter;
  store?: DriftAlertStore;
  severity?: Partial<Record<DriftKind, DriftSeverity>>;
};

export type DriftAlertRunSummary = {
  emitted: number;
  deduplicated: number;
  resolved: number;
  reports: AlertDeliveryReport[];
  failures: Error[];
};

export interface DriftAlertBridge {
  /**
   * Process reconciliation results and emit `anomaly.detected` events for new
   * or changed drift items. Delivery failures are captured in the returned
   * summary and never reject or fail the reconciliation run.
   */
  process(
    results: readonly ReconciliationResult[],
    options?: { at?: string },
  ): Promise<DriftAlertRunSummary>;
}

/**
 * Create a bridge that emits deduplicated `anomaly.detected` alerts for
 * reconciliation drift. The same drift kind and detail on the same subject
 * alerts once until it is resolved or its detail changes.
 */
export function createDriftAlertBridge(options: DriftAlertBridgeOptions): DriftAlertBridge {
  const { emitter, severity } = options;
  const store = options.store ?? createMemoryDriftAlertStore();

  return {
    async process(results, runOptions = {}) {
      const at = runOptions.at ?? new Date().toISOString();
      let emitted = 0;
      let deduplicated = 0;
      let resolved = 0;
      const reports: AlertDeliveryReport[] = [];
      const failures: Error[] = [];

      for (const result of results) {
        const subject = result.channelId;
        const previous = (await store.getActive(subject)) ?? {};

        if (result.ok) {
          resolved += Object.keys(previous).length;
          if (Object.keys(previous).length > 0) {
            await store.setActive(subject, {});
          }
          continue;
        }

        const nextActive = groupDriftsByKind(result.drift);
        const kindsToEmit = new Set<DriftKind>();

        for (const kind of Object.keys(previous)) {
          if (nextActive[kind] === undefined) {
            resolved += 1;
          }
        }

        for (const [kind, signature] of Object.entries(nextActive)) {
          if (previous[kind] === signature) {
            deduplicated += 1;
          } else {
            kindsToEmit.add(kind as DriftKind);
          }
        }

        // A kind whose emit threw never reached the hub. It is left out of the
        // stored state, so the next run alerts on it again instead of treating
        // it as already delivered. Failures the hub reports in its
        // DeliveryReport are the hub's to retry and do count as alerted.
        const unsent = new Set<DriftKind>();
        for (const item of result.drift) {
          if (!kindsToEmit.has(item.kind)) continue;

          try {
            const report = await emitter.emit({
              type: "anomaly.detected",
              at,
              data: {
                source: "reconcile",
                subject,
                kind: item.kind,
                detail: item.detail,
                severity: resolveDriftSeverity(item.kind, severity),
              },
            });
            reports.push(report);
            for (const failure of report.failures) {
              failures.push(failure.error);
            }
          } catch (cause) {
            failures.push(cause instanceof Error ? cause : new Error(String(cause)));
            unsent.add(item.kind);
          }
          emitted += 1;
        }

        for (const kind of unsent) {
          delete nextActive[kind];
        }
        await store.setActive(subject, nextActive);
      }

      return {
        emitted,
        deduplicated,
        resolved,
        reports,
        failures,
      };
    },
  };
}
