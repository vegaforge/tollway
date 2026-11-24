import { TollwayError } from "@vegaforge/tollway-core";
import type { MetricsQuery, SpendSummary } from "./metrics.js";
import {
  METRIC_COLUMNS,
  type MetricRow,
  metricsTables,
  metricValues,
  rowToMetric,
  whereClause,
} from "./metrics-sql.js";
import {
  assertValidMetric,
  closedStoreError,
  decodeCursor,
  encodeCursor,
  type MetricsStore,
  metricTime,
  queryBounds,
  resolvePageLimit,
} from "./metrics-store.js";

/**
 * The part of a Postgres client this store uses. `pg`'s `Pool` and `Client`
 * both fit, so no driver becomes a dependency of this package.
 */
export type PostgresLikeClient = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export type PostgresMetricsStoreOptions = {
  client: PostgresLikeClient;
  /** Prefix for the store's tables. Defaults to `tollway_`. */
  tablePrefix?: string;
};

/**
 * Rows per INSERT statement. A batch up to this size is one statement, so it
 * is written whole or not at all; larger batches are split.
 */
export const POSTGRES_INSERT_CHUNK = 1000;

/**
 * Schema versions in order. A pooled client may run each `query` on a
 * different connection, so a migration cannot rely on a transaction across
 * calls: every statement is safe to re-run on its own, and two processes
 * migrating at once converge on the same schema.
 */
function migrations(tables: ReturnType<typeof metricsTables>): string[][] {
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${tables.metrics} (
        position BIGSERIAL PRIMARY KEY,
        payer TEXT NOT NULL,
        payee TEXT NOT NULL,
        model TEXT NOT NULL,
        amount NUMERIC(78, 0) NOT NULL,
        asset TEXT NOT NULL,
        latency_ms DOUBLE PRECISION NOT NULL,
        outcome TEXT NOT NULL,
        at TEXT NOT NULL,
        at_ms BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_at ON ${tables.metrics} (at_ms)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_payer ON ${tables.metrics} (payer)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_payee ON ${tables.metrics} (payee)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_model ON ${tables.metrics} (model)`,
    ],
  ];
}

/**
 * Creates the store's tables if needed. Safe to call from every process at
 * startup.
 */
export async function migratePostgresMetricsStore(
  client: PostgresLikeClient,
  tablePrefix?: string,
): Promise<void> {
  const tables = metricsTables(tablePrefix);
  await client.query(`CREATE TABLE IF NOT EXISTS ${tables.schema} (version INTEGER PRIMARY KEY)`);
  const { rows } = await client.query(`SELECT version FROM ${tables.schema}`);
  const applied = new Set(rows.map((row) => Number(row.version)));
  const steps = migrations(tables);
  for (const [index, statements] of steps.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    for (const statement of statements) await client.query(statement);
    await client.query(
      `INSERT INTO ${tables.schema} (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [version],
    );
  }
}

/** The dimensions of a summary, in the order the UNION query returns them. */
const DIMENSIONS = ["asset", "model", "payer", "payee"] as const;

function summaryQuery(table: string, where: { sql: string }): string {
  // One statement, so Postgres computes every total from the same snapshot.
  // NUMERIC sums are exact; the result is read back as text, never as a
  // JavaScript number.
  const parts = [
    `SELECT 'total' AS dimension, '' AS key, SUM(amount)::text AS total, COUNT(*) AS n FROM ${table} ${where.sql}`,
    ...DIMENSIONS.map(
      (dimension) =>
        `SELECT '${dimension}' AS dimension, ${dimension} AS key, SUM(amount)::text AS total, COUNT(*) AS n FROM ${table} ${where.sql} GROUP BY ${dimension}`,
    ),
  ];
  return parts.join(" UNION ALL ");
}

function amountText(value: unknown): string {
  if (value === null || value === undefined) return "0";
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) {
    throw new TollwayError("invalid-metric", `database returned a non-integer sum: ${text}`);
  }
  return text;
}

/**
 * A {@link MetricsStore} in Postgres. Amounts are NUMERIC(78, 0), wide enough
 * for any 256-bit base-unit amount, and `summarize` runs as one SQL statement
 * with exact NUMERIC sums. Call {@link migratePostgresMetricsStore} once at
 * startup before using the store.
 */
export function createPostgresMetricsStore(options: PostgresMetricsStoreOptions): MetricsStore {
  const { client } = options;
  const tables = metricsTables(options.tablePrefix);
  let closed = false;

  function open(): void {
    if (closed) throw closedStoreError();
  }

  async function summarize(query: MetricsQuery | undefined): Promise<SpendSummary> {
    const where = whereClause(query, queryBounds(query), 0);
    const { rows } = await client.query(summaryQuery(tables.metrics, where), where.params);
    const summary: SpendSummary = {
      totalAmount: "0",
      count: 0,
      byAsset: {},
      byModel: {},
      byPayer: {},
      byPayee: {},
    };
    for (const row of rows) {
      const total = amountText(row.total);
      const key = String(row.key);
      switch (row.dimension) {
        case "total":
          summary.totalAmount = total;
          summary.count = Number(row.n);
          break;
        case "asset":
          summary.byAsset[key] = total;
          break;
        case "model":
          (summary.byModel as Record<string, string>)[key] = total;
          break;
        case "payer":
          summary.byPayer[key] = total;
          break;
        case "payee":
          summary.byPayee[key] = total;
          break;
        default:
          throw new TollwayError(
            "invalid-metric",
            `database returned an unknown summary dimension: ${String(row.dimension)}`,
          );
      }
    }
    return summary;
  }

  return {
    async append(metrics) {
      open();
      for (const metric of metrics) assertValidMetric(metric);
      for (let start = 0; start < metrics.length; start += POSTGRES_INSERT_CHUNK) {
        const chunk = metrics.slice(start, start + POSTGRES_INSERT_CHUNK);
        const params: unknown[] = [];
        const rows = chunk.map((metric) => {
          const values = metricValues(metric, metricTime(metric));
          const placeholders = values.map((value) => {
            params.push(value);
            return `$${params.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        await client.query(
          `INSERT INTO ${tables.metrics} (${METRIC_COLUMNS}) VALUES ${rows.join(", ")}`,
          params,
        );
      }
    },
    async query(query, page) {
      open();
      const limit = resolvePageLimit(page);
      const where = whereClause(query, queryBounds(query), decodeCursor(page?.cursor));
      const { rows } = await client.query(
        `SELECT position, ${METRIC_COLUMNS} FROM ${tables.metrics} ${where.sql} ORDER BY position LIMIT ${limit + 1}`,
        where.params,
      );
      const metrics = rows.slice(0, limit).map((row) => rowToMetric(row as MetricRow));
      if (rows.length <= limit) return { metrics };
      const last = rows[limit - 1] as MetricRow;
      return { metrics, nextCursor: encodeCursor(Number(last.position)) };
    },
    async summarize(query) {
      open();
      return summarize(query);
    },
    async close() {
      // The client belongs to the caller, who closes its pool.
      closed = true;
    },
  };
}
