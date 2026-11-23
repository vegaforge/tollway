import { describe, expect, it } from "vitest";
import { createObservabilityHub, type PaymentMetric } from "./index.js";

const noSleep = async () => undefined;

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: overrides.payer ?? "GAGENTAAA",
    payee: overrides.payee ?? "GSERVICEAAA",
    model: overrides.model ?? "x402",
    amount: overrides.amount ?? "1000",
    asset: overrides.asset ?? "USDC:GA5Z",
    latencyMs: overrides.latencyMs ?? 42,
    outcome: overrides.outcome ?? "settled",
    at: overrides.at ?? "2026-06-26T10:00:00.000Z",
  };
}

// Regression for #226: a failed or skipped payment moves no money, so it must
// never add to a spend total. Counting it as spend overstates what an agent or
// a service actually paid.
describe("summarize counts only settled amounts as spend", () => {
  it("keeps a failed metric out of every amount and reports it in byOutcome", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "1000", outcome: "settled" }));
    hub.record(metric({ amount: "500", outcome: "failed" }));

    const summary = hub.summarize();

    expect(summary.count).toBe(2);
    expect(summary.byOutcome).toEqual({ settled: 1, failed: 1, skipped: 0 });
    expect(summary.totalAmount).toBe("1000");
    expect(summary.byAsset).toEqual({ "USDC:GA5Z": "1000" });
    expect(summary.byModel).toEqual({ x402: "1000" });
    expect(summary.byPayer).toEqual({ GAGENTAAA: "1000" });
    expect(summary.byPayee).toEqual({ GSERVICEAAA: "1000" });
    expect(summary.byModelAsset).toEqual([
      { model: "x402", asset: "USDC:GA5Z", amount: "1000", count: 1 },
    ]);
    expect(summary.byPayerAsset).toEqual([
      { payer: "GAGENTAAA", asset: "USDC:GA5Z", amount: "1000", count: 1 },
    ]);
    expect(summary.byPayeeAsset).toEqual([
      { payee: "GSERVICEAAA", asset: "USDC:GA5Z", amount: "1000", count: 1 },
    ]);
  });

  it("keeps a skipped metric out of spend as well", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "1000", outcome: "settled" }));
    hub.record(metric({ amount: "7000", outcome: "skipped" }));

    const summary = hub.summarize();

    expect(summary.totalAmount).toBe("1000");
    expect(summary.byAsset).toEqual({ "USDC:GA5Z": "1000" });
    expect(summary.byOutcome).toEqual({ settled: 1, failed: 0, skipped: 1 });
  });

  it("reports two assets as two totals, never one cross-asset number", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ asset: "USDC:GA5Z", amount: "1000", outcome: "settled" }));
    hub.record(metric({ asset: "native", amount: "7", outcome: "settled" }));
    hub.record(metric({ asset: "native", amount: "3", outcome: "failed" }));

    const summary = hub.summarize();

    expect(summary.byAsset).toEqual({ "USDC:GA5Z": "1000", native: "7" });
    expect(summary.byModelAsset).toEqual([
      { model: "x402", asset: "USDC:GA5Z", amount: "1000", count: 1 },
      { model: "x402", asset: "native", amount: "7", count: 1 },
    ]);
  });

  it("filters by outcome and by asset", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "1000", asset: "USDC:GA5Z", outcome: "settled" }));
    hub.record(metric({ amount: "500", asset: "USDC:GA5Z", outcome: "failed" }));
    hub.record(metric({ amount: "7", asset: "native", outcome: "settled" }));

    expect(hub.summarize({ outcome: "failed" })).toMatchObject({
      count: 1,
      byOutcome: { settled: 0, failed: 1, skipped: 0 },
      totalAmount: "0",
      byAsset: {},
    });
    expect(hub.summarize({ asset: "native" })).toMatchObject({
      count: 1,
      byAsset: { native: "7" },
    });
    expect(hub.summarize({ asset: "native", outcome: "failed" })).toMatchObject({
      count: 0,
      byAsset: {},
    });
  });

  it("applies the asset and outcome filters to exports too", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "1000", asset: "USDC:GA5Z", outcome: "settled" }));
    hub.record(metric({ amount: "7", asset: "native", outcome: "settled" }));

    const exported = JSON.parse(hub.export("json", { asset: "native" })) as PaymentMetric[];
    expect(exported.map((entry) => entry.asset)).toEqual(["native"]);
  });
});

describe("timeseries applies the same outcome and asset filters", () => {
  it("filters metrics by asset", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ asset: "USDC:GA5Z", amount: "1000" }));
    hub.record(metric({ asset: "native", amount: "7" }));

    const series = hub.timeseries({
      from: "2026-06-26T10:00:00.000Z",
      to: "2026-06-26T11:00:00.000Z",
      bucket: "1h",
      asset: "native",
    });

    expect(series.buckets.flatMap((bucket) => bucket.rows)).toEqual([
      {
        model: "x402",
        asset: "native",
        amount: "7",
        settled: 1,
        failed: 0,
        skipped: 0,
        latencyMs: { p50: 42, p95: 42, p99: 42 },
      },
    ]);
  });

  it("filters metrics by outcome", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ outcome: "settled", amount: "1000" }));
    hub.record(metric({ outcome: "failed", amount: "5" }));

    const series = hub.timeseries({
      from: "2026-06-26T10:00:00.000Z",
      to: "2026-06-26T11:00:00.000Z",
      bucket: "1h",
      outcome: "failed",
    });

    const rows = series.buckets.flatMap((bucket) => bucket.rows);
    expect(rows).toEqual([
      {
        model: "x402",
        asset: "USDC:GA5Z",
        amount: "0",
        settled: 0,
        failed: 1,
        skipped: 0,
        latencyMs: { p50: 42, p95: 42, p99: 42 },
      },
    ]);
  });
});
