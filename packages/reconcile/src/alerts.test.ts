import { describe, expect, it } from "vitest";
import {
  type AlertDeliveryReport,
  type AlertEmitter,
  type AlertEventInput,
  createDriftAlertBridge,
  createMemoryDriftAlertStore,
  DEFAULT_DRIFT_SEVERITY,
  type DriftKind,
  type ReconciliationResult,
} from "./index.js";

function createFakeHub(
  options: {
    deliver?: (event: AlertEventInput) => Promise<AlertDeliveryReport> | AlertDeliveryReport;
  } = {},
): AlertEmitter & { events: AlertEventInput[] } {
  const events: AlertEventInput[] = [];
  return {
    events,
    async emit(event) {
      events.push(event);
      if (options.deliver) {
        return options.deliver(event);
      }
      return { failures: [] };
    },
  };
}

describe("createDriftAlertBridge", () => {
  it("emits anomaly.detected with source, subject, kind, detail, and severity", async () => {
    const hub = createFakeHub();
    const bridge = createDriftAlertBridge({ emitter: hub });

    const summary = await bridge.process(
      [
        {
          ok: false,
          channelId: "ch-1",
          drift: [{ kind: "under-settled", detail: "shortfall: 100" }],
        },
      ],
      { at: "2026-11-24T00:00:00.000Z" },
    );

    expect(summary.emitted).toBe(1);
    expect(summary.deduplicated).toBe(0);
    expect(summary.failures).toHaveLength(0);
    expect(hub.events).toEqual([
      {
        type: "anomaly.detected",
        at: "2026-11-24T00:00:00.000Z",
        data: {
          source: "reconcile",
          subject: "ch-1",
          kind: "under-settled",
          detail: "shortfall: 100",
          severity: "critical",
        },
      },
    ]);
  });

  it("deduplicates identical drift on the same subject and re-alerts on change or resolution", async () => {
    const hub = createFakeHub();
    const bridge = createDriftAlertBridge({ emitter: hub });

    const first: ReconciliationResult[] = [
      {
        ok: false,
        channelId: "ch-1",
        drift: [{ kind: "under-settled", detail: "shortfall: 100" }],
      },
    ];

    const run1 = await bridge.process(first, { at: "2026-11-24T00:00:00.000Z" });
    expect(run1.emitted).toBe(1);

    // Same drift again -> deduplicated.
    const run2 = await bridge.process(first, { at: "2026-11-24T00:01:00.000Z" });
    expect(run2.emitted).toBe(0);
    expect(run2.deduplicated).toBe(1);
    expect(hub.events).toHaveLength(1);

    // Detail changed -> re-alerts.
    const run3 = await bridge.process(
      [
        {
          ok: false,
          channelId: "ch-1",
          drift: [{ kind: "under-settled", detail: "shortfall: 200" }],
        },
      ],
      { at: "2026-11-24T00:02:00.000Z" },
    );
    expect(run3.emitted).toBe(1);
    expect(hub.events).toHaveLength(2);

    // Resolved -> clears active state.
    const run4 = await bridge.process([{ ok: true, channelId: "ch-1" }], {
      at: "2026-11-24T00:03:00.000Z",
    });
    expect(run4.emitted).toBe(0);
    expect(run4.resolved).toBe(1);

    // Same drift recurs after resolution -> alerts again.
    const run5 = await bridge.process(first, { at: "2026-11-24T00:04:00.000Z" });
    expect(run5.emitted).toBe(1);
    expect(hub.events).toHaveLength(3);
  });

  it("preserves deduplication across restarts when backed by a store", async () => {
    const priorResults: ReconciliationResult[] = [
      { ok: false, channelId: "ch-1", drift: [{ kind: "sequence-gap", detail: "gap at 1" }] },
    ];
    const store = createMemoryDriftAlertStore(priorResults);
    const hub = createFakeHub();
    const bridge = createDriftAlertBridge({ emitter: hub, store });

    const run = await bridge.process(priorResults, { at: "2026-11-24T00:00:00.000Z" });
    expect(run.emitted).toBe(0);
    expect(run.deduplicated).toBe(1);
    expect(hub.events).toHaveLength(0);
  });

  it("applies configurable severity overrides on top of conservative defaults", async () => {
    const hub = createFakeHub();
    const bridge = createDriftAlertBridge({
      emitter: hub,
      severity: { "foreign-commitment": "high" },
    });

    const kinds = Object.keys(DEFAULT_DRIFT_SEVERITY) as DriftKind[];
    await bridge.process(
      kinds.map((kind, i) => ({
        ok: false as const,
        channelId: `ch-${i}`,
        drift: [{ kind, detail: `detail-${kind}` }],
      })),
    );

    const byKind = new Map(hub.events.map((e) => [e.data.kind, e.data.severity]));
    expect(byKind.get("under-settled")).toBe("critical");
    expect(byKind.get("sequence-gap")).toBe("medium");
    expect(byKind.get("foreign-commitment")).toBe("high");
  });

  it("isolates delivery failures reported in DeliveryReport and thrown errors", async () => {
    const reportError = new Error("webhook 503");
    const hub = createFakeHub({
      deliver: async (event) => {
        if (event.data.subject === "ch-throw") {
          throw new Error("unexpected emitter crash");
        }
        return { failures: [{ error: reportError }] };
      },
    });
    const bridge = createDriftAlertBridge({ emitter: hub });

    const summary = await bridge.process([
      { ok: false, channelId: "ch-report", drift: [{ kind: "over-settled", detail: "excess 1" }] },
      { ok: false, channelId: "ch-throw", drift: [{ kind: "over-settled", detail: "excess 2" }] },
    ]);

    expect(summary.emitted).toBe(2);
    expect(summary.reports).toHaveLength(1);
    expect(summary.failures.map((e) => e.message)).toEqual([
      "webhook 503",
      "unexpected emitter crash",
    ]);
  });
  it("alerts again on the next run when emitting a drift threw", async () => {
    // A thrown emit means the alert never reached the hub, so the drift must
    // not be recorded as already alerted: the next run has to try again.
    let crash = true;
    const hub = createFakeHub({
      deliver: async () => {
        if (crash) throw new Error("emitter down");
        return { failures: [] };
      },
    });
    const bridge = createDriftAlertBridge({ emitter: hub });
    const result: ReconciliationResult = {
      ok: false,
      channelId: "ch-retry",
      drift: [{ kind: "under-settled", detail: "shortfall: 5" }],
    };

    const first = await bridge.process([result]);
    expect(first.failures.map((error) => error.message)).toEqual(["emitter down"]);

    crash = false;
    const second = await bridge.process([result]);
    expect(second.emitted).toBe(1);
    expect(second.deduplicated).toBe(0);
    expect(hub.events).toHaveLength(2);

    const third = await bridge.process([result]);
    expect(third.emitted).toBe(0);
    expect(third.deduplicated).toBe(1);
  });
});
