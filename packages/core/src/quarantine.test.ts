import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import { createMemoryQuarantine } from "./quarantine.js";

describe("createMemoryQuarantine", () => {
  it("records a quarantine entry with counterparty, reason, drift, and timestamp", async () => {
    const quarantine = createMemoryQuarantine({
      now: () => "2026-11-24T08:00:00.000Z",
    });

    const entry = await quarantine.quarantine({
      counterparty: "GSERVICE",
      reason: "under-settled by 100",
      drift: {
        kind: "under-settled",
        detail: "channel settled 200 but last commitment was 300",
        channelId: "ch-1",
      },
    });

    expect(entry).toEqual({
      counterparty: "GSERVICE",
      reason: "under-settled by 100",
      drift: {
        kind: "under-settled",
        detail: "channel settled 200 but last commitment was 300",
        channelId: "ch-1",
      },
      quarantinedAt: "2026-11-24T08:00:00.000Z",
    });

    const active = await quarantine.lookup("GSERVICE");
    expect(active).toEqual(entry);
    expect(await quarantine.lookup("GOTHER")).toBeUndefined();
  });

  it("requires explicit audited release and keeps manual entries indefinitely by default", async () => {
    let current = "2026-11-24T08:00:00.000Z";
    const quarantine = createMemoryQuarantine({ now: () => current });

    await quarantine.quarantine({
      counterparty: "GSERVICE",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall" },
    });

    // Advance clock 30 days — still quarantined without explicit release.
    current = "2026-12-24T08:00:00.000Z";
    expect(await quarantine.lookup("GSERVICE")).toBeDefined();

    const released = await quarantine.release({
      counterparty: "GSERVICE",
      releasedBy: "operator@vegaforge.dev",
    });

    expect(released).toMatchObject({
      counterparty: "GSERVICE",
      releasedBy: "operator@vegaforge.dev",
      releasedAt: "2026-12-24T08:00:00.000Z",
    });
    expect(await quarantine.lookup("GSERVICE")).toBeUndefined();

    // Releasing again when not active returns undefined.
    expect(
      await quarantine.release({ counterparty: "GSERVICE", releasedBy: "operator@vegaforge.dev" }),
    ).toBeUndefined();

    // Audit history preserves the released entry.
    const history = await quarantine.history("GSERVICE");
    expect(history).toHaveLength(1);
    expect(history[0]?.releasedBy).toBe("operator@vegaforge.dev");
  });

  it("supports optional autoReleaseAfterMs when explicitly configured", async () => {
    let currentMs = Date.parse("2026-11-24T08:00:00.000Z");
    const quarantine = createMemoryQuarantine({
      autoReleaseAfterMs: 60_000,
      now: () => new Date(currentMs).toISOString(),
    });

    await quarantine.quarantine({
      counterparty: "GSERVICE",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall" },
    });

    currentMs += 30_000;
    expect(await quarantine.lookup("GSERVICE")).toBeDefined();

    currentMs += 30_000;
    expect(await quarantine.lookup("GSERVICE")).toBeUndefined();

    const history = await quarantine.history("GSERVICE");
    expect(history[0]?.releasedBy).toBe("auto-expiry");
  });

  it("rejects empty counterparty or releasedBy", async () => {
    const quarantine = createMemoryQuarantine();

    await expect(
      quarantine.quarantine({
        counterparty: "   ",
        reason: "drift",
        drift: { kind: "under-settled", detail: "shortfall" },
      }),
    ).rejects.toThrow(TollwayError);

    await expect(quarantine.release({ counterparty: "GSERVICE", releasedBy: " " })).rejects.toThrow(
      TollwayError,
    );
  });
});
