import { createMemoryQuarantine } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import type { Drift, DriftKind, ReconciliationResult } from "./index.js";
import { createQuarantineEnforcer, DEFAULT_DRIFT_ACTIONS } from "./quarantine.js";

describe("createQuarantineEnforcer", () => {
  it("quarantines on under-settled by default and warns on non-quarantine drift", async () => {
    const quarantine = createMemoryQuarantine();
    const onWarn = vi.fn();
    const onQuarantine = vi.fn();
    const enforcer = createQuarantineEnforcer({ quarantine, onWarn, onQuarantine });

    const result: ReconciliationResult = {
      ok: false,
      channelId: "ch-1",
      drift: [
        { kind: "sequence-gap", detail: "missing seq 1" },
        { kind: "under-settled", detail: "settled 100 vs 200" },
      ],
    };

    const out = await enforcer.process({ counterparty: "GSERVICE", result });
    expect(out.duplicate).toBe(false);
    expect(out.actions).toHaveLength(2);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledTimes(1);

    const entry = await quarantine.lookup("GSERVICE");
    expect(entry).toBeDefined();
    expect(entry?.drift.kind).toBe("under-settled");
    expect(entry?.drift.channelId).toBe("ch-1");
  });

  it("triggers each drift kind's configured action exactly once per result, even when processed twice", async () => {
    const quarantine = createMemoryQuarantine();
    const quarantineSpy = vi.spyOn(quarantine, "quarantine");
    const onWarn = vi.fn();
    const onQuarantine = vi.fn();

    const enforcer = createQuarantineEnforcer({ quarantine, onWarn, onQuarantine });

    const result: ReconciliationResult = {
      ok: false,
      channelId: "ch-1",
      drift: [
        { kind: "under-settled", detail: "shortfall 1" },
        { kind: "under-settled", detail: "shortfall 2" },
        { kind: "over-settled", detail: "excess 1" },
      ],
    };

    const first = await enforcer.process({ counterparty: "GSERVICE", result });
    expect(first.duplicate).toBe(false);
    expect(quarantineSpy).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);

    // Processing the same result again is a no-op.
    const second = await enforcer.process({ counterparty: "GSERVICE", result });
    expect(second.duplicate).toBe(true);
    expect(second.actions).toEqual([]);
    expect(quarantineSpy).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("supports configurable drift-kind-to-action overrides and ignore", async () => {
    const quarantine = createMemoryQuarantine();
    const onWarn = vi.fn();
    const enforcer = createQuarantineEnforcer({
      quarantine,
      actions: {
        "under-settled": "ignore",
        "over-settled": "quarantine",
      },
      onWarn,
    });

    const underResult: ReconciliationResult = {
      ok: false,
      channelId: "ch-1",
      drift: [{ kind: "under-settled", detail: "ignored" }],
    };
    const out1 = await enforcer.process({ counterparty: "G1", result: underResult });
    expect(out1.actions[0]).toMatchObject({ action: "ignore", quarantined: false });
    expect(await quarantine.lookup("G1")).toBeUndefined();
    expect(onWarn).not.toHaveBeenCalled();

    const overResult: ReconciliationResult = {
      ok: false,
      channelId: "ch-2",
      drift: [{ kind: "over-settled", detail: "now quarantined" }],
    };
    const out2 = await enforcer.process({ counterparty: "G2", result: overResult });
    expect(out2.actions[0]).toMatchObject({ action: "quarantine", quarantined: true });
    expect(await quarantine.lookup("G2")).toBeDefined();
  });

  it("never quarantines on ok results or unknown/unverifiable outcomes", async () => {
    const quarantine = createMemoryQuarantine();
    const enforcer = createQuarantineEnforcer({ quarantine });

    const okOut = await enforcer.process({
      counterparty: "G1",
      result: { ok: true, channelId: "ch-1" },
    });
    expect(okOut).toEqual({ duplicate: false, actions: [] });

    // Simulate an unknown/unverifiable drift kind (e.g. transient outcome).
    const transientDrift = {
      kind: "unverifiable" as DriftKind,
      detail: "rpc timeout",
    } satisfies Drift;
    const out = await enforcer.process({
      counterparty: "G1",
      result: { ok: false, channelId: "ch-1", drift: [transientDrift] },
    });
    expect(out.actions[0]).toMatchObject({ action: "ignore", quarantined: false });
    expect(await quarantine.lookup("G1")).toBeUndefined();
  });

  it("defaults recipient-mismatch and token-mismatch to quarantine", () => {
    expect(DEFAULT_DRIFT_ACTIONS["under-settled"]).toBe("quarantine");
    expect(DEFAULT_DRIFT_ACTIONS["recipient-mismatch"]).toBe("quarantine");
    expect(DEFAULT_DRIFT_ACTIONS["token-mismatch"]).toBe("quarantine");
  });
  it("forgets the oldest processed result once maxRememberedResults is reached", async () => {
    const quarantine = createMemoryQuarantine();
    const onWarn = vi.fn();
    const enforcer = createQuarantineEnforcer({ quarantine, onWarn, maxRememberedResults: 2 });
    const result = (channelId: string): ReconciliationResult => ({
      ok: false,
      channelId,
      drift: [{ kind: "sequence-gap", detail: `gap in ${channelId}` }],
    });

    await enforcer.process({ counterparty: "GPAYEE", result: result("ch-1") });
    await enforcer.process({ counterparty: "GPAYEE", result: result("ch-2") });
    await enforcer.process({ counterparty: "GPAYEE", result: result("ch-3") });

    // ch-3 and ch-2 are remembered; ch-1 was forgotten to keep memory bounded.
    expect(
      (await enforcer.process({ counterparty: "GPAYEE", result: result("ch-3") })).duplicate,
    ).toBe(true);
    expect(
      (await enforcer.process({ counterparty: "GPAYEE", result: result("ch-1") })).duplicate,
    ).toBe(false);
    expect(onWarn).toHaveBeenCalledTimes(4);
  });

  it("refuses a maxRememberedResults that is not a positive integer", () => {
    const quarantine = createMemoryQuarantine();
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => createQuarantineEnforcer({ quarantine, maxRememberedResults: value })).toThrow(
        TypeError,
      );
    }
  });
});
