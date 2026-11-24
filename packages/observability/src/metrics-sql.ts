import type { MetricsQuery, PaymentMetric } from "./metrics.js";
import { assertValidMetric, type TimeBounds } from "./metrics-store.js";

/**
 * SQL shared by the SQLite and Postgres metrics stores. Both dialects accept
 * numbered placeholders, written `$1` here; the SQLite store rewrites them to
 * its own `?1` form.
 */

/** Table names. Callers may prefix them to share a database with other data. */
export type MetricsTables = { metrics: string; schema: string };

export function metricsTables(prefix = "tollway_"): MetricsTables {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    // The prefix is spliced into SQL, so only a plain identifier is accepted.
    throw new TypeError(
      `table prefix must be a lowercase SQL identifier, got ${JSON.stringify(prefix)}`,
    );
  }
  return { metrics: `${prefix}metrics`, schema: `${prefix}metrics_schema` };
}

export type SqlFragment = { sql: string; params: unknown[] };

/**
 * The WHERE clause for a query: the field filters, the time bounds and the
 * cursor position. `firstParam` is the number of the first placeholder.
 */
export function whereClause(
  query: MetricsQuery | undefined,
  bounds: TimeBounds,
  after: number,
  firstParam = 1,
): SqlFragment {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const next = (value: unknown): string => {
    params.push(value);
    return `$${firstParam + params.length - 1}`;
  };
  if (after > 0) conditions.push(`position > ${next(after)}`);
  if (query?.payer !== undefined) conditions.push(`payer = ${next(query.payer)}`);
  if (query?.payee !== undefined) conditions.push(`payee = ${next(query.payee)}`);
  if (query?.model !== undefined) conditions.push(`model = ${next(query.model)}`);
  if (query?.asset !== undefined) conditions.push(`asset = ${next(query.asset)}`);
  if (query?.outcome !== undefined) conditions.push(`outcome = ${next(query.outcome)}`);
  if (bounds.from !== null) conditions.push(`at_ms >= ${next(bounds.from)}`);
  if (bounds.to !== null) conditions.push(`at_ms <= ${next(bounds.to)}`);
  return { sql: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`, params };
}

/** Columns in the order every SELECT and INSERT uses them. */
export const METRIC_COLUMNS =
  "payer, payee, model, amount, asset, latency_ms, outcome, at, at_ms" as const;

/** The values for one INSERT row, in {@link METRIC_COLUMNS} order. */
export function metricValues(metric: PaymentMetric, time: number): unknown[] {
  return [
    metric.payer,
    metric.payee,
    metric.model,
    metric.amount,
    metric.asset,
    metric.latencyMs,
    metric.outcome,
    metric.at,
    time,
  ];
}

/** A row as both stores return it from `SELECT position, METRIC_COLUMNS`. */
export type MetricRow = {
  position: number | string | bigint;
  payer: string;
  payee: string;
  model: string;
  amount: string | number | bigint;
  asset: string;
  latency_ms: number | string;
  outcome: string;
  at: string;
};

/**
 * Maps a stored row back to a metric. A database can be shared with other
 * writers, so every row is validated on the way out exactly as on the way in,
 * and a corrupt row fails the read instead of reaching a rollup.
 */
export function rowToMetric(row: MetricRow): PaymentMetric {
  const metric = {
    payer: row.payer,
    payee: row.payee,
    // Narrowed by assertValidMetric below, which checks both against their
    // closed sets before the value leaves this function.
    model: row.model as PaymentMetric["model"],
    amount: String(row.amount),
    asset: row.asset,
    latencyMs: Number(row.latency_ms),
    outcome: row.outcome as PaymentMetric["outcome"],
    at: row.at,
  };
  assertValidMetric(metric);
  return metric;
}

/**
 * Rewrites `$N` placeholders to SQLite's anonymous `?` and orders the
 * parameters to match. A placeholder used twice gets its value twice.
 */
export function toAnonymousPlaceholders(sql: string, params: readonly unknown[]): SqlFragment {
  const ordered: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return "?";
  });
  return { sql: text, params: ordered };
}
