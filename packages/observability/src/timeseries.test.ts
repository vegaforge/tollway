import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import {
  createObservabilityHub,
  MetricsQueryTooLargeError,
  nearestRankPercentile,
  type PaymentMetric,
  parseIsoTimestamp,
  type TimeseriesBucket,
  type TimeseriesRow,
} from "./index.js";

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: "GAGENTAAA",
    payee: "GSERVICEAAA",
    model: "x402",
    amount: "1000",
    asset: "USDC:GA5Z",
    latencyMs: 42,
    outcome: "settled",
    at: "2026-06-26T10:00:00.000Z",
    ...overrides,
  };
}

function hubWith(
  metrics: PaymentMetric[],
  options: Parameters<typeof createObservabilityHub>[0] = {},
) {
  const hub = createObservabilityHub(options);
  for (const m of metrics) hub.record(m);
  return hub;
}

function expectTollwayError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TollwayError);
  expect((caught as TollwayError).code).toBe(code);
}

describe("parseIsoTimestamp", () => {
  it("reads UTC and offset timestamps to the same instant", () => {
    expect(parseIsoTimestamp("2026-06-26T10:00:00Z")).toBe(Date.UTC(2026, 5, 26, 10));
    expect(parseIsoTimestamp("2026-06-26T15:30:00+05:30")).toBe(Date.UTC(2026, 5, 26, 10));
    expect(parseIsoTimestamp("2026-06-26T10:00Z")).toBe(Date.UTC(2026, 5, 26, 10));
    expect(parseIsoTimestamp("2026-06-26T10:00:00.123456Z")).toBe(
      Date.UTC(2026, 5, 26, 10, 0, 0, 123),
    );
  });

  it("rejects timestamps without a zone, impossible dates and other text", () => {
    for (const bad of [
      "2026-06-26T10:00:00",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01 10:00:00Z",
      "yesterday",
      "",
    ]) {
      expect(parseIsoTimestamp(bad)).toBeNull();
    }
    expect(parseIsoTimestamp("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
  });
});

describe("nearestRankPercentile", () => {
  it("returns the sample at rank ceil(p/100 * n)", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(nearestRankPercentile(sorted, 50)).toBe(50);
    expect(nearestRankPercentile(sorted, 95)).toBe(95);
    expect(nearestRankPercentile(sorted, 99)).toBe(99);
    // With 4 samples, p95 is rank ceil(3.8) = 4 and p50 is rank 2.
    expect(nearestRankPercentile([10, 20, 30, 40], 50)).toBe(20);
    expect(nearestRankPercentile([10, 20, 30, 40], 95)).toBe(40);
    expect(nearestRankPercentile([7], 99)).toBe(7);
  });

  it("refuses an empty sample set or an out-of-range percentile", () => {
    expect(() => nearestRankPercentile([], 50)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1], 0)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1], 101)).toThrow(RangeError);
  });
});

describe("hub.timeseries: bucket alignment", () => {
  it("aligns hourly buckets to UTC hours and crosses a day boundary", () => {
    const hub = hubWith([
      metric({ at: "2026-06-26T22:59:59.999Z", amount: "1" }),
      metric({ at: "2026-06-26T23:00:00.000Z", amount: "10" }),
      metric({ at: "2026-06-27T00:00:00.000Z", amount: "100" }),
      // An offset timestamp that is 00:30 UTC on the 27th.
      metric({ at: "2026-06-27T02:30:00+02:00", amount: "1000" }),
    ]);

    const series = hub.timeseries({
      from: "2026-06-26T22:15:00Z",
      to: "2026-06-27T01:00:00Z",
      bucket: "1h",
    });

    expect(series.from).toBe("2026-06-26T22:00:00.000Z");
    expect(series.to).toBe("2026-06-27T01:00:00.000Z");
    expect(series.buckets.map((b) => [b.start, b.end])).toEqual([
      ["2026-06-26T22:00:00.000Z", "2026-06-26T23:00:00.000Z"],
      ["2026-06-26T23:00:00.000Z", "2026-06-27T00:00:00.000Z"],
      ["2026-06-27T00:00:00.000Z", "2026-06-27T01:00:00.000Z"],
    ]);
    expect(series.buckets.map((b) => b.rows[0]?.amount)).toEqual(["1", "10", "1100"]);
  });

  it("aligns daily buckets to UTC midnight regardless of the offset in the query", () => {
    const hub = hubWith([
      metric({ at: "2026-06-26T23:59:59Z", amount: "5" }),
      metric({ at: "2026-06-27T00:00:00Z", amount: "7" }),
    ]);
    // 2026-06-27T02:00+05:00 is 2026-06-26T21:00Z, so the first bucket is the 26th.
    const series = hub.timeseries({
      from: "2026-06-27T02:00:00+05:00",
      to: "2026-06-28T00:00:00Z",
      bucket: "1d",
    });
    expect(series.buckets.map((b) => b.start)).toEqual([
      "2026-06-26T00:00:00.000Z",
      "2026-06-27T00:00:00.000Z",
    ]);
    expect(series.buckets.map((b) => b.rows[0]?.amount)).toEqual(["5", "7"]);
  });

  it("treats the range as half-open: a metric at `to` is excluded, one at `from` included", () => {
    const hub = hubWith([
      metric({ at: "2026-06-26T10:00:00Z", amount: "1" }),
      metric({ at: "2026-06-26T10:05:00Z", amount: "2" }),
    ]);
    const series = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T10:05:00Z",
      bucket: "5m",
    });
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0]?.rows[0]).toMatchObject({ amount: "1", settled: 1 });
  });

  it("excludes metrics before `from` even inside the first rounded-down bucket", () => {
    const hub = hubWith([
      metric({ at: "2026-06-26T10:00:10Z", amount: "1" }),
      metric({ at: "2026-06-26T10:00:40Z", amount: "2" }),
    ]);
    const series = hub.timeseries({
      from: "2026-06-26T10:00:30Z",
      to: "2026-06-26T10:01:00Z",
      bucket: "1m",
    });
    expect(series.buckets[0]?.start).toBe("2026-06-26T10:00:00.000Z");
    expect(series.buckets[0]?.rows[0]?.amount).toBe("2");
  });
});

describe("hub.timeseries: empty buckets", () => {
  it("returns every bucket in the range with zero rows for idle groups", () => {
    const hub = hubWith([
      metric({ at: "2026-06-26T10:00:00Z", latencyMs: 30 }),
      metric({ at: "2026-06-26T10:03:00Z", latencyMs: 50 }),
    ]);
    const series = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T10:04:00Z",
      bucket: "1m",
    });
    expect(series.buckets).toHaveLength(4);
    expect(series.buckets[1]?.rows).toEqual([
      {
        model: "x402",
        asset: "USDC:GA5Z",
        amount: "0",
        settled: 0,
        failed: 0,
        skipped: 0,
        latencyMs: null,
      },
    ]);
    expect(series.buckets[3]?.rows[0]?.latencyMs).toEqual({ p50: 50, p95: 50, p99: 50 });
  });

  it("returns contiguous empty buckets when nothing was recorded", () => {
    const series = hubWith([]).timeseries({
      from: "2026-06-26T00:00:00Z",
      to: "2026-06-26T03:00:00Z",
      bucket: "1h",
    });
    expect(series.buckets).toHaveLength(3);
    for (const bucket of series.buckets) expect(bucket.rows).toEqual([]);
  });
});

describe("hub.timeseries: grouping", () => {
  it("keeps assets apart, splits by model, and sums with bigint", () => {
    const hub = hubWith([
      metric({ asset: "USDC:GA5Z", amount: "9007199254740992" }),
      metric({ asset: "USDC:GA5Z", amount: "9007199254740992" }),
      metric({ asset: "native", amount: "3" }),
      metric({ model: "mpp-charge", asset: "native", amount: "4" }),
    ]);
    const rows = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T11:00:00Z",
      bucket: "1h",
    }).buckets[0]?.rows;

    expect(rows?.map((r) => [r.model, r.asset, r.amount])).toEqual([
      ["mpp-charge", "native", "4"],
      ["x402", "USDC:GA5Z", "18014398509481984"],
      ["x402", "native", "3"],
    ]);
  });

  it("adds payee or payer as a third key when asked", () => {
    const metrics = [
      metric({ payer: "GA1", payee: "GS1", amount: "1" }),
      metric({ payer: "GA1", payee: "GS2", amount: "2" }),
      metric({ payer: "GA2", payee: "GS2", amount: "4" }),
    ];
    const range = { from: "2026-06-26T10:00:00Z", to: "2026-06-26T11:00:00Z" } as const;
    const hub = hubWith(metrics);

    const byPayee = hub.timeseries({ ...range, bucket: "1h", groupBy: "payee" });
    expect(byPayee.groupBy).toBe("payee");
    expect(byPayee.buckets[0]?.rows.map((r) => [r.payee, r.amount, r.payer])).toEqual([
      ["GS1", "1", undefined],
      ["GS2", "6", undefined],
    ]);

    const byPayer = hub.timeseries({ ...range, bucket: "1h", groupBy: "payer" });
    expect(byPayer.buckets[0]?.rows.map((r) => [r.payer, r.amount])).toEqual([
      ["GA1", "3"],
      ["GA2", "4"],
    ]);

    const byModel = hub.timeseries({ ...range, bucket: "1h" });
    expect(byModel.groupBy).toBe("model");
    expect(byModel.buckets[0]?.rows).toHaveLength(1);
    expect(byModel.buckets[0]?.rows[0]).not.toHaveProperty("payee");
  });

  it("applies payer, payee and model filters", () => {
    const hub = hubWith([
      metric({ payer: "GA1", amount: "1" }),
      metric({ payer: "GA2", amount: "2" }),
      metric({ payer: "GA1", model: "mpp-channel", amount: "4" }),
    ]);
    const rows = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T11:00:00Z",
      bucket: "1h",
      payer: "GA1",
      model: "x402",
    }).buckets[0]?.rows;
    expect(rows?.map((r) => r.amount)).toEqual(["1"]);
  });
});

describe("hub.timeseries: outcomes and latency", () => {
  it("splits counts by outcome and only adds settled amounts", () => {
    const hub = hubWith([
      metric({ outcome: "settled", amount: "100", latencyMs: 10 }),
      metric({ outcome: "failed", amount: "5000", latencyMs: 900 }),
      metric({ outcome: "skipped", amount: "7000", latencyMs: 1 }),
      metric({ outcome: "settled", amount: "200", latencyMs: 20 }),
    ]);
    const row = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T11:00:00Z",
      bucket: "1h",
    }).buckets[0]?.rows[0];
    expect(row).toMatchObject({ amount: "300", settled: 2, failed: 1, skipped: 1 });
    // Samples sorted: [1, 10, 20, 900]. p50 is rank 2; p95 and p99 are rank 4.
    expect(row?.latencyMs).toEqual({ p50: 10, p95: 900, p99: 900 });
  });

  it("does not parse the amount of a failed or skipped metric", () => {
    const hub = hubWith([metric({ outcome: "failed", amount: "" })]);
    const row = hub.timeseries({
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T11:00:00Z",
      bucket: "1h",
    }).buckets[0]?.rows[0];
    expect(row).toMatchObject({ amount: "0", failed: 1 });
  });
});

describe("hub.timeseries: validation", () => {
  const range = { from: "2026-06-26T10:00:00Z", to: "2026-06-26T11:00:00Z" } as const;

  it("rejects a malformed query with invalid-metrics-query", () => {
    const hub = hubWith([]);
    const bad: Array<Record<string, unknown>> = [
      { ...range, bucket: "2h" },
      { ...range, bucket: "1h", groupBy: "asset" },
      { from: range.from, bucket: "1h" },
      { from: "2026-06-26T10:00:00", to: range.to, bucket: "1h" },
      { from: range.to, to: range.from, bucket: "1h" },
      { from: range.from, to: range.from, bucket: "1h" },
    ];
    for (const query of bad) {
      // Deliberately untyped input: the hub must check what arrives at runtime.
      expectTollwayError(
        () => hub.timeseries(query as unknown as Parameters<typeof hub.timeseries>[0]),
        "invalid-metrics-query",
      );
    }
  });

  it("rejects an unparseable recorded timestamp instead of skipping it", () => {
    const hub = hubWith([metric({ at: "26/06/2026 10:00" })]);
    expectTollwayError(() => hub.timeseries({ ...range, bucket: "1h" }), "invalid-metric");
  });

  it("rejects a settled metric whose amount is not an integer string", () => {
    for (const amount of ["1.5", "-3", "abc", ""]) {
      const hub = hubWith([metric({ amount })]);
      expectTollwayError(() => hub.timeseries({ ...range, bucket: "1h" }), "invalid-metric");
    }
  });

  it("rejects a latency that is negative or not finite", () => {
    for (const latencyMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const hub = hubWith([metric({ latencyMs })]);
      expectTollwayError(() => hub.timeseries({ ...range, bucket: "1h" }), "invalid-metric");
    }
  });

  it("rejects a limit option below one at construction", () => {
    expectTollwayError(
      () => createObservabilityHub({ maxTimeseriesBuckets: 0 }),
      "invalid-metrics-query",
    );
    expectTollwayError(
      () => createObservabilityHub({ maxTimeseriesRows: 1.5 }),
      "invalid-metrics-query",
    );
  });
});

describe("hub.timeseries: size limits", () => {
  it("rejects a range with more buckets than the configured maximum", () => {
    const hub = hubWith([], { maxTimeseriesBuckets: 24 });
    // 24 hourly buckets fit exactly.
    expect(
      hub.timeseries({ from: "2026-06-26T00:00:00Z", to: "2026-06-27T00:00:00Z", bucket: "1h" })
        .buckets,
    ).toHaveLength(24);

    let caught: unknown;
    try {
      hub.timeseries({ from: "2026-06-26T00:00:00Z", to: "2026-06-27T00:00:01Z", bucket: "1h" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MetricsQueryTooLargeError);
    expect(caught).toMatchObject({
      code: "metrics-query-too-large",
      limit: "buckets",
      requested: 25,
      maximum: 24,
    });
  });

  it("applies the default bucket limit to a year of one-minute buckets", () => {
    const hub = hubWith([]);
    expect(() =>
      hub.timeseries({ from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z", bucket: "1m" }),
    ).toThrow(MetricsQueryTooLargeError);
  });

  it("rejects a result with more rows (buckets times groups) than the maximum", () => {
    const hub = hubWith(
      [metric({ payee: "GS1" }), metric({ payee: "GS2" }), metric({ payee: "GS3" })],
      { maxTimeseriesRows: 5 },
    );
    const query = {
      from: "2026-06-26T10:00:00Z",
      to: "2026-06-26T12:00:00Z",
      bucket: "1h",
    } as const;
    // One group (model + asset) times 2 buckets fits.
    expect(hub.timeseries(query).buckets).toHaveLength(2);
    // Three payees times 2 buckets is 6 rows.
    expect(() => hub.timeseries({ ...query, groupBy: "payee" })).toThrow(
      expect.objectContaining({ limit: "rows", requested: 6, maximum: 5 }),
    );
  });
});

// Property tests. A small seeded generator keeps every run reproducible
// without adding a property-testing dependency to this package: a failure
// reports its seed, and the same seed rebuilds the same metrics.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANGE_START = Date.UTC(2026, 5, 26, 22, 0, 0);
const RANGE_END = Date.UTC(2026, 5, 27, 2, 0, 0);

function randomMetrics(seed: number): PaymentMetric[] {
  const random = mulberry32(seed);
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error("pick from an empty list");
    return value;
  };
  const count = Math.floor(random() * 200);
  const metrics: PaymentMetric[] = [];
  for (let i = 0; i < count; i += 1) {
    // Spread a little past both ends so the range filter is exercised too.
    const at = RANGE_START - 600_000 + Math.floor(random() * (RANGE_END - RANGE_START + 1_200_000));
    metrics.push(
      metric({
        payer: pick(["GA1", "GA2", "GA3"]),
        payee: pick(["GS1", "GS2"]),
        model: pick(["x402", "mpp-charge", "mpp-channel"] as const),
        asset: pick(["USDC:GA5Z", "native", "EURC:GB3Q"]),
        amount: BigInt(Math.floor(random() * 1e12)).toString(),
        latencyMs: Math.floor(random() * 5000),
        outcome: pick(["settled", "settled", "failed", "skipped"] as const),
        at: new Date(at).toISOString(),
      }),
    );
  }
  return metrics;
}

function inRange(m: PaymentMetric): boolean {
  const at = Date.parse(m.at);
  return at >= RANGE_START && at < RANGE_END;
}

function allRows(series: { buckets: Array<{ rows: TimeseriesRow[] }> }): TimeseriesRow[] {
  return series.buckets.flatMap((b) => b.rows);
}

describe("hub.timeseries: properties over random metrics", () => {
  const seeds = Array.from({ length: 50 }, (_, i) => i + 1);
  const bucketWidths: TimeseriesBucket[] = ["1m", "5m", "1h", "1d"];
  const query = (bucket: TimeseriesBucket) => ({
    from: new Date(RANGE_START).toISOString(),
    to: new Date(RANGE_END).toISOString(),
    bucket,
  });

  it.each(seeds)("seed %i: bucket counts add up to the metrics in range", (seed) => {
    const metrics = randomMetrics(seed);
    const hub = hubWith(metrics);
    for (const bucket of bucketWidths) {
      const total = allRows(hub.timeseries(query(bucket))).reduce(
        (sum, r) => sum + r.settled + r.failed + r.skipped,
        0,
      );
      expect(total).toBe(metrics.filter(inRange).length);
    }
  });

  it.each(seeds)("seed %i: per-asset bucket sums equal the per-asset settled total", (seed) => {
    const metrics = randomMetrics(seed);
    const expected = new Map<string, bigint>();
    for (const m of metrics.filter(inRange)) {
      if (m.outcome !== "settled") continue;
      expected.set(m.asset, (expected.get(m.asset) ?? 0n) + BigInt(m.amount));
    }
    const hub = hubWith(metrics);
    for (const bucket of bucketWidths) {
      for (const groupBy of ["model", "payee", "payer"] as const) {
        const actual = new Map<string, bigint>();
        for (const r of allRows(hub.timeseries({ ...query(bucket), groupBy }))) {
          actual.set(r.asset, (actual.get(r.asset) ?? 0n) + BigInt(r.amount));
        }
        for (const [asset, sum] of expected) expect(actual.get(asset)).toBe(sum);
        for (const [asset, sum] of actual) expect(sum).toBe(expected.get(asset) ?? 0n);
      }
    }
  });

  it.each(seeds)("seed %i: p50 <= p95 <= p99 on every row with samples", (seed) => {
    const hub = hubWith(randomMetrics(seed));
    for (const bucket of bucketWidths) {
      for (const r of allRows(hub.timeseries(query(bucket)))) {
        const samples = r.settled + r.failed + r.skipped;
        if (samples === 0) {
          expect(r.latencyMs).toBeNull();
          continue;
        }
        expect(r.latencyMs).not.toBeNull();
        if (r.latencyMs === null) continue;
        expect(r.latencyMs.p50).toBeLessThanOrEqual(r.latencyMs.p95);
        expect(r.latencyMs.p95).toBeLessThanOrEqual(r.latencyMs.p99);
      }
    }
  });

  it.each(seeds)("seed %i: buckets are contiguous and every bucket has every group", (seed) => {
    const hub = hubWith(randomMetrics(seed));
    for (const bucket of bucketWidths) {
      const series = hub.timeseries(query(bucket));
      const keys = (rows: TimeseriesRow[]) => rows.map((r) => `${r.model}|${r.asset}`);
      const first = series.buckets[0];
      expect(first?.start).toBe(series.from);
      expect(series.buckets.at(-1)?.end).toBe(series.to);
      for (let i = 1; i < series.buckets.length; i += 1) {
        expect(series.buckets[i]?.start).toBe(series.buckets[i - 1]?.end);
        expect(keys(series.buckets[i]?.rows ?? [])).toEqual(keys(first?.rows ?? []));
      }
    }
  });
});
