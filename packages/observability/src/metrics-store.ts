import { type SettlementModel, settlementModels, TollwayError } from "@vegaforge/tollway-core";
import type { MetricsQuery, PaymentMetric, SpendSummary } from "./metrics.js";
import { parseIsoTimestamp } from "./timeseries.js";

/**
 * Durable storage for payment metrics (#217). The hub writes to a store in
 * batches; dashboards and exporters read rollups back from it. Every store
 * returns the same results for the same data: the conformance suite in
 * `metrics-store.test.ts` runs against each one.
 */
export interface MetricsStore {
  /**
   * Appends metrics in one batch. Rejects with {@link InvalidMetricError}
   * before writing anything when a metric is malformed, so a batch is never
   * half written for that reason.
   */
  append(metrics: readonly PaymentMetric[]): Promise<void>;
  /** Matching metrics in insertion order, one page at a time. */
  query(query?: MetricsQuery, page?: MetricsPageRequest): Promise<MetricsPage>;
  /** The spend summary for matching metrics, computed by the store. */
  summarize(query?: MetricsQuery): Promise<SpendSummary>;
  /** Releases the store's resources. A closed store rejects every call. */
  close(): Promise<void>;
}

export type MetricsPageRequest = {
  /** Most metrics to return. Defaults to 1000, at most 10000. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type MetricsPage = {
  metrics: PaymentMetric[];
  /** Present when more metrics match; pass it as `cursor` for the next page. */
  nextCursor?: string;
};

export const DEFAULT_METRICS_PAGE_LIMIT = 1000;
export const MAX_METRICS_PAGE_LIMIT = 10_000;

/** A metric a store refuses to write, naming the field that is wrong. */
export class InvalidMetricError extends TollwayError {
  readonly field: keyof PaymentMetric;

  constructor(field: keyof PaymentMetric, message: string) {
    super("invalid-metric", `invalid payment metric: ${field} ${message}`);
    this.name = "InvalidMetricError";
    this.field = field;
  }
}

const AMOUNT = /^[0-9]+$/;
const OUTCOMES: readonly PaymentMetric["outcome"][] = ["settled", "failed", "skipped"];

/**
 * Checks a metric before a durable store writes it. Amounts are integer
 * strings in the asset's smallest unit, the same rule as receipts, so a
 * rollup never has to skip a row it cannot sum.
 */
export function assertValidMetric(metric: PaymentMetric): void {
  for (const field of ["payer", "payee", "asset"] as const) {
    if (typeof metric[field] !== "string" || metric[field].length === 0) {
      throw new InvalidMetricError(field, "must be a non-empty string");
    }
  }
  if (typeof metric.amount !== "string" || !AMOUNT.test(metric.amount)) {
    throw new InvalidMetricError(
      "amount",
      `must be an integer string in the asset's smallest unit, got ${JSON.stringify(metric.amount)}`,
    );
  }
  if (!settlementModels.includes(metric.model as SettlementModel)) {
    throw new InvalidMetricError("model", `is not a settlement model: ${String(metric.model)}`);
  }
  if (!OUTCOMES.includes(metric.outcome)) {
    throw new InvalidMetricError("outcome", `is not an outcome: ${String(metric.outcome)}`);
  }
  if (!Number.isFinite(metric.latencyMs) || metric.latencyMs < 0) {
    throw new InvalidMetricError("latencyMs", "must be a finite, non-negative number");
  }
  if (typeof metric.at !== "string" || parseIsoTimestamp(metric.at) === null) {
    throw new InvalidMetricError("at", "must be an ISO 8601 timestamp with a zone");
  }
}

/**
 * The epoch milliseconds of a metric's `at`. Stores keep `at` exactly as
 * recorded and order and filter on this value, so `2026-01-01T01:00:00+01:00`
 * and `2026-01-01T00:00:00Z` are the same instant.
 */
export function metricTime(metric: Pick<PaymentMetric, "at">): number {
  const time = parseIsoTimestamp(metric.at);
  if (time === null)
    throw new InvalidMetricError("at", "must be an ISO 8601 timestamp with a zone");
  return time;
}

/** A query's time bounds as epoch milliseconds, both inclusive. */
export type TimeBounds = { from: number | null; to: number | null };

export function queryBounds(query: MetricsQuery | undefined): TimeBounds {
  return { from: bound(query?.from, "from"), to: bound(query?.to, "to") };
}

function bound(value: string | undefined, name: "from" | "to"): number | null {
  if (value === undefined) return null;
  const time = parseIsoTimestamp(value);
  if (time === null) {
    throw new TollwayError(
      "invalid-metrics-query",
      `${name} must be an ISO 8601 timestamp with a zone`,
    );
  }
  return time;
}

/** Copies only the metric's own fields, so a store never keeps extra keys. */
export function copyMetric(metric: PaymentMetric): PaymentMetric {
  return {
    payer: metric.payer,
    payee: metric.payee,
    model: metric.model,
    amount: metric.amount,
    asset: metric.asset,
    latencyMs: metric.latencyMs,
    outcome: metric.outcome,
    at: metric.at,
  };
}

/** True when a stored metric matches every set field of the query. */
export function metricMatches(
  metric: PaymentMetric,
  time: number,
  query: MetricsQuery | undefined,
  bounds: TimeBounds,
): boolean {
  if (query?.payer !== undefined && metric.payer !== query.payer) return false;
  if (query?.payee !== undefined && metric.payee !== query.payee) return false;
  if (query?.model !== undefined && metric.model !== query.model) return false;
  if (query?.asset !== undefined && metric.asset !== query.asset) return false;
  if (query?.outcome !== undefined && metric.outcome !== query.outcome) return false;
  if (bounds.from !== null && time < bounds.from) return false;
  if (bounds.to !== null && time > bounds.to) return false;
  return true;
}

export function resolvePageLimit(page: MetricsPageRequest | undefined): number {
  const limit = page?.limit ?? DEFAULT_METRICS_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_METRICS_PAGE_LIMIT) {
    throw new TollwayError(
      "invalid-metrics-query",
      `page limit must be a whole number from 1 to ${MAX_METRICS_PAGE_LIMIT}, got ${limit}`,
    );
  }
  return limit;
}

const CURSOR_PREFIX = "m1.";

/** Cursors are opaque to callers: a version prefix and the last row's position. */
export function encodeCursor(position: number): string {
  return `${CURSOR_PREFIX}${position}`;
}

/** The position after which the next page starts, or 0 for the first page. */
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const raw = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : "";
  const position = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(position)) {
    throw new TollwayError("invalid-metrics-query", "page cursor is not one this store issued");
  }
  return position;
}

/** Throws the error every store uses once it has been closed. */
export function closedStoreError(): TollwayError {
  return new TollwayError("invalid-metrics-query", "the metrics store is closed");
}
