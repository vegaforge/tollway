import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  METRIC_COLUMNS,
  type MetricRow,
  metricsTables,
  metricValues,
  rowToMetric,
  type SqlFragment,
  toAnonymousPlaceholders,
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
import { loadSqlite } from "./sqlite.js";
import { SummaryAccumulator } from "./summary.js";

export type SqliteMetricsStoreOptions = {
  /** Database file, or `:memory:`. */
  filename: string;
  /**
   * How long a write waits for another connection's lock before failing
   * with `database is locked`. Defaults to 500ms. `node:sqlite` blocks the
   * event loop while it waits, so keep this short.
   */
  busyTimeoutMs?: number;
  /** Prefix for the store's tables. Defaults to `tollway_`. */
  tablePrefix?: string;
};

/**
 * Schema versions in order. Each step is applied once and recorded in the
 * schema table, and every statement is safe to re-run, so opening an
 * up-to-date database changes nothing.
 */
function migrations(tables: ReturnType<typeof metricsTables>): string[][] {
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${tables.metrics} (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        payer TEXT NOT NULL,
        payee TEXT NOT NULL,
        model TEXT NOT NULL,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        outcome TEXT NOT NULL,
        at TEXT NOT NULL,
        at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_at ON ${tables.metrics} (at_ms)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_payer ON ${tables.metrics} (payer)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_payee ON ${tables.metrics} (payee)`,
      `CREATE INDEX IF NOT EXISTS ${tables.metrics}_model ON ${tables.metrics} (model)`,
    ],
  ];
}

function migrate(db: DatabaseSync, tables: ReturnType<typeof metricsTables>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${tables.schema} (version INTEGER PRIMARY KEY)`);
  const applied = new Set(
    db
      .prepare(`SELECT version FROM ${tables.schema}`)
      .all()
      .map((row) => Number(row.version)),
  );
  migrations(tables).forEach((statements, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) db.exec(statement);
      db.prepare(`INSERT OR IGNORE INTO ${tables.schema} (version) VALUES (?)`).run(version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/**
 * A {@link MetricsStore} in a SQLite file, using the built-in `node:sqlite`
 * module so it adds no dependency. Amounts are stored as TEXT and summed in
 * TypeScript with bigint: SQLite's SUM is a 64-bit or floating-point sum and
 * is not exact for every base-unit amount.
 *
 * `node:sqlite` is loaded inside this factory, not at module load, so
 * importing the package never requires it.
 */
export function createSqliteMetricsStore(options: SqliteMetricsStoreOptions): MetricsStore {
  const busyTimeoutMs = options.busyTimeoutMs ?? 500;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a non-negative whole number, got ${busyTimeoutMs}`);
  }
  const tables = metricsTables(options.tablePrefix);
  const { DatabaseSync } = loadSqlite("createSqliteMetricsStore");
  const db = new DatabaseSync(options.filename);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  migrate(db, tables);

  const insert = db.prepare(
    `INSERT INTO ${tables.metrics} (${METRIC_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let closed = false;

  function open(): void {
    if (closed) throw closedStoreError();
  }

  function select(columns: string, where: SqlFragment, tail = ""): MetricRow[] {
    const { sql, params } = toAnonymousPlaceholders(
      `SELECT ${columns} FROM ${tables.metrics} ${where.sql} ${tail}`,
      where.params,
    );
    return db.prepare(sql).all(...(params as SQLInputValue[])) as MetricRow[];
  }

  return {
    async append(metrics) {
      open();
      for (const metric of metrics) assertValidMetric(metric);
      if (metrics.length === 0) return;
      // One transaction per batch: either every metric is written or none is.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const metric of metrics) {
          insert.run(...(metricValues(metric, metricTime(metric)) as SQLInputValue[]));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async query(query, page) {
      open();
      const limit = resolvePageLimit(page);
      const where = whereClause(query, queryBounds(query), decodeCursor(page?.cursor));
      const rows = select(
        `position, ${METRIC_COLUMNS}`,
        where,
        `ORDER BY position LIMIT ${limit + 1}`,
      );
      const metrics = rows.slice(0, limit).map(rowToMetric);
      if (rows.length <= limit) return { metrics };
      const last = rows[limit - 1] as MetricRow;
      return { metrics, nextCursor: encodeCursor(Number(last.position)) };
    },
    async summarize(query) {
      open();
      const where = whereClause(query, queryBounds(query), 0);
      const summary = new SummaryAccumulator();
      // The filter runs in SQL; the exact sum runs here, one row at a time.
      const { sql, params } = toAnonymousPlaceholders(
        `SELECT position, ${METRIC_COLUMNS} FROM ${tables.metrics} ${where.sql}`,
        where.params,
      );
      for (const row of db.prepare(sql).iterate(...(params as SQLInputValue[]))) {
        summary.add(rowToMetric(row as MetricRow));
      }
      return summary.result();
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
