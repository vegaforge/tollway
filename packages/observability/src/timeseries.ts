/**
 * Time-series rollups over recorded payment metrics: per time bucket, per
 * model and asset (and optionally per payee or payer), the settled amount,
 * the settled / failed / skipped counts, and latency percentiles. This feeds
 * "spend over time" and "latency per model" in docs/design.md,
 * "Observability".
 */

import type { SettlementModel } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import type { MetricsQuery, PaymentMetric } from "./metrics.js";

/** Bucket widths a time series can be cut into. */
export const timeseriesBuckets = ["1m", "5m", "1h", "1d"] as const;

export type TimeseriesBucket = (typeof timeseriesBuckets)[number];

const BUCKET_MS: Record<TimeseriesBucket, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/**
 * Which dimensions split a row. Every row is always split by model and
 * asset; `"payee"` or `"payer"` adds that address as a third key.
 */
export type TimeseriesGroupBy = "model" | "payee" | "payer";

const GROUP_BY_VALUES: readonly TimeseriesGroupBy[] = ["model", "payee", "payer"];

export type TimeseriesQuery = Omit<MetricsQuery, "from" | "to"> & {
  /**
   * Start of the range, ISO 8601 with `Z` or an explicit offset. Inclusive.
   * The first bucket starts at `from` rounded down to the bucket width.
   */
  from: string;
  /**
   * End of the range, ISO 8601 with `Z` or an explicit offset. Exclusive,
   * unlike `MetricsQuery.to`, so `[00:00, 24:00)` in `1h` buckets is exactly
   * 24 buckets with no metric counted twice.
   */
  to: string;
  bucket: TimeseriesBucket;
  /** Defaults to `"model"`. */
  groupBy?: TimeseriesGroupBy;
};

/**
 * Latency percentiles in milliseconds, by the nearest-rank method on the
 * exact samples: sort the n samples ascending, and the p-th percentile is
 * the sample at 1-based rank `ceil(p / 100 * n)`. Every value is a latency
 * that was actually recorded; nothing is interpolated.
 */
export type LatencyPercentiles = {
  p50: number;
  p95: number;
  p99: number;
};

export type TimeseriesRow = {
  model: SettlementModel;
  asset: string;
  /** Present only when the query grouped by payee. */
  payee?: string;
  /** Present only when the query grouped by payer. */
  payer?: string;
  /**
   * Sum of `amount` over the row's `settled` metrics, as an integer string
   * in the asset's smallest unit. Failed and skipped metrics move no money,
   * so they never add to it.
   */
  amount: string;
  settled: number;
  failed: number;
  skipped: number;
  /**
   * Percentiles over the latency of every metric in the row, whatever its
   * outcome. `null` when the row has no metrics in this bucket.
   */
  latencyMs: LatencyPercentiles | null;
};

export type TimeseriesBucketResult = {
  /** Bucket start, inclusive, as an ISO 8601 UTC timestamp. */
  start: string;
  /** Bucket end, exclusive, as an ISO 8601 UTC timestamp. */
  end: string;
  /**
   * One row per group seen anywhere in the range, in the same order in every
   * bucket, so each group is a contiguous series. A group with no metrics in
   * this bucket gets a row with zero counts.
   */
  rows: TimeseriesRow[];
};

export type TimeseriesResult = {
  bucket: TimeseriesBucket;
  groupBy: TimeseriesGroupBy;
  /** Start of the first bucket (the query's `from`, rounded down). */
  from: string;
  /** End of the last bucket (the query's `to`, rounded up). */
  to: string;
  /** Every bucket in the range, in time order, including empty ones. */
  buckets: TimeseriesBucketResult[];
};

export type TimeseriesLimits = {
  /** Most buckets one query may produce. */
  maxBuckets: number;
  /** Most rows one query may produce, counted as buckets times groups. */
  maxRows: number;
};

/**
 * Seven days of one-minute buckets. A wider range is still available at a
 * coarser bucket width.
 */
export const DEFAULT_MAX_TIMESERIES_BUCKETS = 10_080;

/**
 * Caps the dense grid of buckets times groups. Each row is a small object,
 * so this keeps one query's result in the tens of megabytes at most.
 */
export const DEFAULT_MAX_TIMESERIES_ROWS = 200_000;

/**
 * Thrown when a time-series query would produce more buckets or rows than
 * the hub allows. The check runs before the result is allocated, so a
 * mistaken range cannot exhaust memory.
 */
export class MetricsQueryTooLargeError extends TollwayError {
  readonly limit: "buckets" | "rows";
  readonly requested: number;
  readonly maximum: number;

  constructor(limit: "buckets" | "rows", requested: number, maximum: number) {
    super(
      "metrics-query-too-large",
      `time series would produce ${requested} ${limit}, more than the maximum of ${maximum}`,
    );
    this.name = "MetricsQueryTooLargeError";
    this.limit = limit;
    this.requested = requested;
    this.maximum = maximum;
  }
}

// Calendar date, time, optional seconds and fraction, and a mandatory zone.
// A timestamp without a zone would be read in the host's time zone, which
// would make bucket boundaries depend on where the process runs.
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. Date.UTC never
  // consults the host time zone.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse an ISO 8601 timestamp to epoch milliseconds, or return `null` when
 * it is not one. `Date.parse` alone is too lenient: it accepts
 * `2026-02-30` by rolling it into March, and it reads a timestamp without a
 * zone in local time.
 */
export function parseIsoTimestamp(value: string): number | null {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zulu, sign, offH, offM] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Buckets are at least a minute wide, so digits past milliseconds cannot
  // move a metric to another bucket. They are dropped, not rounded, so a
  // timestamp never moves forward across a boundary.
  const millis = frac === undefined ? 0 : Number(frac.slice(0, 3).padEnd(3, "0"));

  let offsetMinutes = 0;
  if (zulu === undefined) {
    const offsetHours = Number(offH);
    const offsetMins = Number(offM);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

/**
 * The p-th percentile of `sorted` (ascending, non-empty) by nearest rank.
 * See {@link LatencyPercentiles}.
 */
export function nearestRankPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new RangeError("nearestRankPercentile needs at least one sample");
  }
  if (!(p > 0 && p <= 100)) {
    throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const value = sorted[rank - 1];
  if (value === undefined) {
    // Unreachable: 1 <= rank <= length for p in (0, 100]. The check satisfies
    // noUncheckedIndexedAccess without a cast.
    throw new RangeError(`rank ${rank} is outside ${sorted.length} samples`);
  }
  return value;
}

function latencyPercentiles(samples: number[]): LatencyPercentiles | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: nearestRankPercentile(sorted, 50),
    p95: nearestRankPercentile(sorted, 95),
    p99: nearestRankPercentile(sorted, 99),
  };
}

function invalidQuery(message: string): TollwayError {
  return new TollwayError("invalid-metrics-query", message);
}

function invalidMetric(metric: PaymentMetric, reason: string): TollwayError {
  return new TollwayError(
    "invalid-metric",
    `recorded metric at ${JSON.stringify(metric.at)} for ${metric.payer} -> ${metric.payee} ${reason}`,
  );
}

type Group = {
  key: string;
  model: SettlementModel;
  asset: string;
  address: string | undefined;
};

type Cell = {
  amount: bigint;
  settled: number;
  failed: number;
  skipped: number;
  latencies: number[];
};

function compareGroups(a: Group, b: Group): number {
  // Plain code-unit comparison, so the order does not depend on the host
  // locale the way localeCompare would.
  const fields: Array<[string, string]> = [
    [a.model, b.model],
    [a.asset, b.asset],
    [a.address ?? "", b.address ?? ""],
  ];
  for (const [x, y] of fields) {
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Validate a limits object handed to the hub. A limit below one would
 * reject every query, which is a configuration mistake to surface early.
 */
export function assertTimeseriesLimits(limits: TimeseriesLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidQuery(`time-series limit ${name} must be a positive integer, got ${value}`);
    }
  }
}

/**
 * Compute a time series over `metrics`. Pure: it reads the array and
 * allocates only the result.
 */
export function computeTimeseries(
  metrics: readonly PaymentMetric[],
  query: TimeseriesQuery,
  limits: TimeseriesLimits,
): TimeseriesResult {
  // The type already requires these, but the hub is called from JavaScript
  // and from parsed request bodies too, so check what actually arrived.
  if (!(timeseriesBuckets as readonly string[]).includes(query.bucket)) {
    throw invalidQuery(`bucket must be one of ${timeseriesBuckets.join(", ")}`);
  }
  const groupBy = query.groupBy ?? "model";
  if (!GROUP_BY_VALUES.includes(groupBy)) {
    throw invalidQuery(`groupBy must be one of ${GROUP_BY_VALUES.join(", ")}`);
  }
  if (typeof query.from !== "string" || typeof query.to !== "string") {
    throw invalidQuery("a time series needs both from and to");
  }
  const fromMs = parseIsoTimestamp(query.from);
  if (fromMs === null) {
    throw invalidQuery(`from is not an ISO 8601 timestamp with a zone: ${query.from}`);
  }
  const toMs = parseIsoTimestamp(query.to);
  if (toMs === null) {
    throw invalidQuery(`to is not an ISO 8601 timestamp with a zone: ${query.to}`);
  }
  if (fromMs >= toMs) {
    throw invalidQuery(`from must be earlier than to (from ${query.from}, to ${query.to})`);
  }

  // Bucket starts are whole multiples of the width counted from the Unix
  // epoch. The epoch is midnight UTC and every width divides a UTC day, so
  // `1h` and `1d` buckets land on UTC hour and day boundaries.
  const width = BUCKET_MS[query.bucket];
  const firstStart = Math.floor(fromMs / width) * width;
  const bucketCount = Math.ceil((toMs - firstStart) / width);
  if (bucketCount > limits.maxBuckets) {
    throw new MetricsQueryTooLargeError("buckets", bucketCount, limits.maxBuckets);
  }

  const groups = new Map<string, Group>();
  // Cells are sparse until the end: bucket index -> group key -> cell.
  const cells = new Map<number, Map<string, Cell>>();

  for (const m of metrics) {
    if (query.payer !== undefined && m.payer !== query.payer) continue;
    if (query.payee !== undefined && m.payee !== query.payee) continue;
    if (query.model !== undefined && m.model !== query.model) continue;
    if (query.asset !== undefined && m.asset !== query.asset) continue;
    if (query.outcome !== undefined && m.outcome !== query.outcome) continue;

    const atMs = parseIsoTimestamp(m.at);
    if (atMs === null) {
      throw invalidMetric(m, "has an `at` that is not an ISO 8601 timestamp with a zone");
    }
    if (atMs < fromMs || atMs >= toMs) continue;

    if (!Number.isFinite(m.latencyMs) || m.latencyMs < 0) {
      throw invalidMetric(m, `has latencyMs ${m.latencyMs}, not a finite non-negative number`);
    }

    const address = groupBy === "payee" ? m.payee : groupBy === "payer" ? m.payer : undefined;
    // JSON of an array cannot collide for different field values, unlike a
    // join on a separator that could appear inside an asset code.
    const key = JSON.stringify([m.model, m.asset, address ?? null]);
    if (!groups.has(key)) {
      groups.set(key, { key, model: m.model, asset: m.asset, address });
    }

    const index = Math.floor((atMs - firstStart) / width);
    let bucketCells = cells.get(index);
    if (!bucketCells) {
      bucketCells = new Map();
      cells.set(index, bucketCells);
    }
    let cell = bucketCells.get(key);
    if (!cell) {
      cell = { amount: 0n, settled: 0, failed: 0, skipped: 0, latencies: [] };
      bucketCells.set(key, cell);
    }

    cell.latencies.push(m.latencyMs);
    if (m.outcome === "settled") {
      if (!/^[0-9]+$/.test(m.amount)) {
        throw invalidMetric(m, `has amount ${JSON.stringify(m.amount)}, not an integer string`);
      }
      cell.amount += BigInt(m.amount);
      cell.settled += 1;
    } else if (m.outcome === "failed") {
      cell.failed += 1;
    } else if (m.outcome === "skipped") {
      cell.skipped += 1;
    } else {
      throw invalidMetric(m, `has an unknown outcome ${JSON.stringify(m.outcome)}`);
    }
  }

  const rowCount = bucketCount * groups.size;
  if (rowCount > limits.maxRows) {
    throw new MetricsQueryTooLargeError("rows", rowCount, limits.maxRows);
  }

  const orderedGroups = [...groups.values()].sort(compareGroups);
  const buckets: TimeseriesBucketResult[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const start = firstStart + index * width;
    const bucketCells = cells.get(index);
    const rows = orderedGroups.map((group): TimeseriesRow => {
      const cell = bucketCells?.get(group.key);
      const row: TimeseriesRow = {
        model: group.model,
        asset: group.asset,
        amount: (cell?.amount ?? 0n).toString(),
        settled: cell?.settled ?? 0,
        failed: cell?.failed ?? 0,
        skipped: cell?.skipped ?? 0,
        latencyMs: latencyPercentiles(cell?.latencies ?? []),
      };
      if (groupBy === "payee") row.payee = group.address;
      if (groupBy === "payer") row.payer = group.address;
      return row;
    });
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(start + width).toISOString(),
      rows,
    });
  }

  return {
    bucket: query.bucket,
    groupBy,
    from: new Date(firstStart).toISOString(),
    to: new Date(firstStart + bucketCount * width).toISOString(),
    buckets,
  };
}
