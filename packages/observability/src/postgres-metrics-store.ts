import { TollwayError } from "@vegaforge/tollway-core";
import type {
  MetricsQuery,
  ModelAssetSpend,
  PayeeAssetSpend,
  PayerAssetSpend,
  SpendSummary,
} from "./metrics.js";
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

/** Settled-amount breakdowns: the dimension name and the columns it groups by. */
const BREAKDOWNS = [
  ["asset", ["asset"]],
  ["model", ["model"]],
  ["payer", ["payer"]],
  ["payee", ["payee"]],
  ["model_asset", ["model", "asset"]],
  ["payer_asset", ["payer", "asset"]],
  ["payee_asset", ["payee", "asset"]],
] as const;

function summaryQuery(table: string, where: { sql: string }): string {
  // One statement, so Postgres computes every figure from the same snapshot.
  // Outcome counts cover every matched metric; amounts cover settled ones
  // only, because a failed or skipped payment moved no money. NUMERIC sums
  // are exact and are read back as text, never as a JavaScript number.
  const settled =
    where.sql === "" ? "WHERE outcome = 'settled'" : `${where.sql} AND outcome = 'settled'`;
  const parts = [
    `SELECT 'outcome' AS dimension, outcome AS a, '' AS b, NULL AS total, COUNT(*) AS n FROM ${table} ${where.sql} GROUP BY outcome`,
    `SELECT 'total', '', '', SUM(amount)::text, COUNT(*) FROM ${table} ${settled}`,
    ...BREAKDOWNS.map(([dimension, columns]) => {
      const a = columns[0];
      const b = columns[1] ?? "''";
      return `SELECT '${dimension}', ${a}, ${b}, SUM(amount)::text, COUNT(*) FROM ${table} ${settled} GROUP BY ${columns.join(", ")}`;
    }),
  ];
  return parts.join(" UNION ALL ");
}

/** Asset first, then the group's label, in plain code-unit order. */
function byAssetThen<T extends { asset: string }>(label: (row: T) => string) {
  return (left: T, right: T): number => {
    if (left.asset !== right.asset) return left.asset < right.asset ? -1 : 1;
    const a = label(left);
    const b = label(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  };
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
    const byOutcome = { settled: 0, failed: 0, skipped: 0 };
    let totalAmount = "0";
    const flat = { asset: {}, model: {}, payer: {}, payee: {} } as Record<
      "asset" | "model" | "payer" | "payee",
      Record<string, string>
    >;
    const pairs = {
      model_asset: [] as ModelAssetSpend[],
      payer_asset: [] as PayerAssetSpend[],
      payee_asset: [] as PayeeAssetSpend[],
    };
    for (const row of rows) {
      const a = String(row.a);
      const b = String(row.b);
      const n = Number(row.n);
      switch (row.dimension) {
        case "outcome":
          if (a !== "settled" && a !== "failed" && a !== "skipped") {
            throw new TollwayError("invalid-metric", `database returned an unknown outcome: ${a}`);
          }
          byOutcome[a] = n;
          break;
        case "total":
          totalAmount = amountText(row.total);
          break;
        case "asset":
        case "model":
        case "payer":
        case "payee":
          flat[row.dimension][a] = amountText(row.total);
          break;
        case "model_asset":
          pairs.model_asset.push({
            model: a as ModelAssetSpend["model"],
            asset: b,
            amount: amountText(row.total),
            count: n,
          });
          break;
        case "payer_asset":
          pairs.payer_asset.push({ payer: a, asset: b, amount: amountText(row.total), count: n });
          break;
        case "payee_asset":
          pairs.payee_asset.push({ payee: a, asset: b, amount: amountText(row.total), count: n });
          break;
        default:
          throw new TollwayError(
            "invalid-metric",
            `database returned an unknown summary dimension: ${String(row.dimension)}`,
          );
      }
    }
    return {
      totalAmount,
      count: byOutcome.settled + byOutcome.failed + byOutcome.skipped,
      byOutcome,
      byAsset: flat.asset,
      byModel: flat.model as SpendSummary["byModel"],
      byPayer: flat.payer,
      byPayee: flat.payee,
      // Sorted here, not in SQL, so the order matches the other stores
      // whatever the database collation.
      byModelAsset: pairs.model_asset.sort(byAssetThen((row) => row.model)),
      byPayerAsset: pairs.payer_asset.sort(byAssetThen((row) => row.payer)),
      byPayeeAsset: pairs.payee_asset.sort(byAssetThen((row) => row.payee)),
    };
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
