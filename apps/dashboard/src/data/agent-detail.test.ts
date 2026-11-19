import { POLICY_TRACE_VERSION } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";

import {
  fetchAgentDetail,
  percentageBasisPoints,
  rangeWindow,
  STUB_NOW,
  stopFromTrace,
  stubAgentIds,
  UnknownAgentError,
  utcDay,
} from "./agent-detail";

describe("percentageBasisPoints", () => {
  it("returns 0 when nothing is spent", () => {
    expect(percentageBasisPoints(0n, 10_000_000n)).toBe(0n);
  });

  it("returns 10000 at exactly the limit", () => {
    expect(percentageBasisPoints(10_000_000n, 10_000_000n)).toBe(10_000n);
  });

  it("returns more than 10000 over the limit", () => {
    expect(percentageBasisPoints(12_000_000n, 10_000_000n)).toBe(12_000n);
  });

  it("multiplies before dividing so small ratios keep precision", () => {
    expect(percentageBasisPoints(1n, 3n)).toBe(3333n);
    expect(percentageBasisPoints(1n, 10_000n)).toBe(1n);
  });

  it("stays exact on values far past Number.MAX_SAFE_INTEGER", () => {
    expect(percentageBasisPoints(12_345_678_901_234_567_890n, 99_999_999_999_999_999_999n)).toBe(
      1234n,
    );
  });

  it("has no percentage for a zero limit", () => {
    expect(percentageBasisPoints(0n, 0n)).toBeNull();
    expect(percentageBasisPoints(1n, 0n)).toBeNull();
  });
});

describe("rangeWindow and utcDay", () => {
  const now = Date.parse("2026-11-19T18:30:00.000Z");

  it("ends at the end of the bucket holding now and spans the range", () => {
    expect(rangeWindow(now, { bucket: "hour", range: "24h" })).toEqual({
      from: "2026-11-18T19:00:00.000Z",
      to: "2026-11-19T19:00:00.000Z",
    });
    expect(rangeWindow(now, { bucket: "day", range: "7d" })).toEqual({
      from: "2026-11-13T00:00:00.000Z",
      to: "2026-11-20T00:00:00.000Z",
    });
  });

  it("names the UTC day the way the policy engine does", () => {
    expect(utcDay(Date.parse("2026-11-19T23:59:59.999Z"))).toBe("2026-11-19");
    expect(utcDay(Date.parse("2026-11-20T00:00:00.000+01:00"))).toBe("2026-11-19");
  });
});

describe("fetchAgentDetail (stub through the observability hub)", () => {
  it("returns identity and the payer mapping", async () => {
    const detail = await fetchAgentDetail("agent-research-01", { bucket: "day", range: "7d" });

    expect(detail).toMatchObject({
      id: "agent-research-01",
      label: "research-bot",
      payerAddresses: ["GAGENTRESEARCH1", "GAGENTRESEARCH2"],
    });
  });

  it("buckets settled spend per asset, dense, and leaves failed payments out", async () => {
    const detail = await fetchAgentDetail("agent-research-01", { bucket: "day", range: "7d" });

    expect(detail.series.map((series) => series.asset)).toEqual(["USDC", "XLM"]);
    const usdc = detail.series[0]?.points ?? [];
    expect(usdc).toHaveLength(7);
    expect(usdc.at(-1)).toEqual({
      start: "2026-11-19T00:00:00.000Z",
      end: "2026-11-20T00:00:00.000Z",
      amount: "3500000000",
    });
    expect(usdc.at(-2)?.amount).toBe("1500000000");
    expect(usdc[0]?.amount).toBe("0");
  });

  it("cuts hour buckets on UTC hours across two payer addresses", async () => {
    const detail = await fetchAgentDetail("agent-research-01", { bucket: "hour", range: "24h" });

    const usdc = detail.series.find((series) => series.asset === "USDC")?.points ?? [];
    expect(usdc).toHaveLength(24);
    expect(usdc.find((point) => point.start === "2026-11-19T10:00:00.000Z")?.amount).toBe(
      "2500000000",
    );
    expect(usdc.find((point) => point.start === "2026-11-19T12:00:00.000Z")?.amount).toBe("0");
    const xlm = detail.series.find((series) => series.asset === "XLM")?.points ?? [];
    expect(xlm.find((point) => point.start === "2026-11-19T11:00:00.000Z")?.amount).toBe(
      "2000000000",
    );
  });

  it("drops spend outside the range", async () => {
    const day = await fetchAgentDetail("agent-research-01", { bucket: "hour", range: "24h" });
    const month = await fetchAgentDetail("agent-research-01", { bucket: "day", range: "30d" });

    const usdcModel = (detail: typeof day) =>
      detail.byModel.find((row) => row.key === "x402" && row.asset === "USDC")?.amount;
    expect(usdcModel(day)).toBe("2500000000");
    expect(usdcModel(month)).toBe("5200000000");
  });

  it("measures limits in the engine's windows", async () => {
    const { policy } = await fetchAgentDetail("agent-research-01", { bucket: "day", range: "24h" });

    expect(policy?.utcDay).toBe(utcDay(STUB_NOW));
    expect(policy?.daily).toEqual({
      limit: "5000000000",
      usedByAsset: [
        { asset: "USDC", amount: "3500000000" },
        { asset: "XLM", amount: "2000000000" },
      ],
      windowStart: "2026-11-19T00:00:00.000Z",
    });
    // Total and per-service caps are lifetime windows, from the policy start.
    expect(policy?.total.usedByAsset).toEqual([
      { asset: "USDC", amount: "6200000000" },
      { asset: "XLM", amount: "2000000000" },
    ]);
    expect(policy?.perService).toEqual([
      expect.objectContaining({
        payee: "GSERVICEALPHA",
        limit: "10000000000",
        usedByAsset: [{ asset: "USDC", amount: "6200000000" }],
      }),
      expect.objectContaining({
        payee: "GSERVICEBETA",
        limit: "3000000000",
        usedByAsset: [{ asset: "XLM", amount: "2000000000" }],
      }),
    ]);
  });

  it("returns null for an agent with no policy", async () => {
    const detail = await fetchAgentDetail("agent-summarizer-02", { bucket: "day", range: "7d" });

    expect(detail.policy).toBeNull();
    expect(detail.recentStops).toEqual([]);
  });

  it("derives recent stops from engine traces, newest first", async () => {
    const { recentStops } = await fetchAgentDetail("agent-research-01", {
      bucket: "day",
      range: "7d",
    });

    expect(recentStops.map((stop) => [stop.at, stop.ruleId, stop.rule])).toEqual([
      ["2026-11-19T17:45:00.000Z", "per-service", "per-service"],
      ["2026-11-19T16:20:00.000Z", "budget-daily", "budget"],
    ]);
    expect(recentStops[1]?.detail).toBe("daily budget exceeded for USDC: 5500000000 > 5000000000");
    expect(recentStops[1]?.trace.version).toBe(POLICY_TRACE_VERSION);
  });

  it("rejects an unknown agent", async () => {
    await expect(fetchAgentDetail("nobody", { bucket: "day", range: "7d" })).rejects.toThrow(
      UnknownAgentError,
    );
  });

  it("covers every agent in the agents list", async () => {
    const { fetchAgentSpend } = await import("./agent-spend");
    const { rows } = await fetchAgentSpend();

    expect(rows.map((row) => row.id)).toEqual([...stubAgentIds]);
  });
});

describe("stopFromTrace", () => {
  it("rejects a trace that did not block and one of an unknown version", async () => {
    const { recentStops } = await fetchAgentDetail("agent-research-01", {
      bucket: "day",
      range: "7d",
    });
    const trace = recentStops[0]?.trace;
    if (trace === undefined) throw new Error("fixture has a stop");

    expect(() => stopFromTrace({ ...trace, version: 99 })).toThrow();
    const passing = {
      ...trace,
      allowed: true,
      wouldBlock: false,
      blockedBy: null,
      entries: trace.entries.map((entry) => ({ ...entry, outcome: "pass" })),
    };
    expect(() => stopFromTrace(passing)).toThrow(/did not block/);
  });
});
