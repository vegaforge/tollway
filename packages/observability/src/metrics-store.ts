/**
 * Persistent metrics storage with SQLite and Postgres support.
 * Metrics are stored durably across process restarts for long-term
 * observability and analytics.
 */

import type { PaymentMetric, MetricsQuery } from "./index.js";

/** Persistence boundary for payment metrics. */
export interface MetricsStore {
  /** Records one or more payment metrics. */
  record(...metrics: PaymentMetric[]): Promise<void>;
  /**
   * Queries metrics matching the filter, ordered by timestamp.
   * Bounds are inclusive.
   */
  query(filter?: MetricsQuery): Promise<PaymentMetric[]>;
  /** Deletes metrics older than the given timestamp (epoch milliseconds). */
  purge(olderThan: number): Promise<number>;
  /** Closes the underlying store (if applicable). */
  close?(): void;
}

export type SqliteMetricsStoreOptions = {
  /** Database file path, or `:memory:`. */
  filename: string;
  /**
   * How long a write waits for another connection's lock before failing.
   * Defaults to 500ms. Keep short to avoid blocking the event loop.
   */
  busyTimeoutMs?: number;
};

export type SqliteMetricsStore = MetricsStore & {
  close(): void;
};

const DEFAULT_BUSY_TIMEOUT_MS = 500;

function loadSqlite(): typeof import("node:sqlite") {
  const unavailable = () =>
    new Error(
      "createSqliteMetricsStore needs node:sqlite, available without a flag from Node 22.13.0; ensure your Node version supports node:sqlite",
    );
  if (typeof process.getBuiltinModule !== "function") throw unavailable();
  let sqlite: typeof import("node:sqlite") | undefined;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } catch (cause) {
    throw Object.assign(unavailable(), { cause });
  }
  if (!sqlite) throw unavailable();
  return sqlite;
}

/**
 * In-memory metrics store. Rows disappear with the process.
 * Suitable for development and testing.
 */
export function createMemoryMetricsStore(): MetricsStore {
  const metrics: PaymentMetric[] = [];

  return {
    async record(...newMetrics) {
      metrics.push(...newMetrics.map((m) => ({ ...m })));
    },
    async query(filter) {
      return metrics
        .slice()
        .filter((m) => {
          if (filter?.payer !== undefined && m.payer !== filter.payer) return false;
          if (filter?.payee !== undefined && m.payee !== filter.payee) return false;
          if (filter?.model !== undefined && m.model !== filter.model) return false;
          if (filter?.from !== undefined && m.at < filter.from) return false;
          if (filter?.to !== undefined && m.at > filter.to) return false;
          return true;
        })
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    async purge(olderThan) {
      const before = metrics.length;
      // Purge metrics with timestamp less than the threshold
      const cutoff = new Date(olderThan).toISOString();
      let removed = 0;
      for (let i = metrics.length - 1; i >= 0; i--) {
        if (metrics[i].at < cutoff) {
          metrics.splice(i, 1);
          removed++;
        }
      }
      return removed;
    },
  };
}

/**
 * SQLite-backed metrics store using `node:sqlite`.
 * Supports concurrent reads and writes with locking.
 */
export function createSqliteMetricsStore(options: SqliteMetricsStoreOptions): SqliteMetricsStore {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError("busyTimeoutMs must be a non-negative integer");
  }

  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(options.filename);

  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_metrics (
      id TEXT PRIMARY KEY,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      model TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      at TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS payment_metrics_payer_at
      ON payment_metrics (payer, at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS payment_metrics_payee_at
      ON payment_metrics (payee, at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS payment_metrics_model_at
      ON payment_metrics (model, at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS payment_metrics_at
      ON payment_metrics (at)
  `);

  const insert = db.prepare(`
    INSERT INTO payment_metrics (
      id, payer, payee, model, amount, asset, latency_ms, outcome, at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectByFilter = db.prepare(`
    SELECT id, payer, payee, model, amount, asset, latency_ms, outcome, at
    FROM payment_metrics
    WHERE (? IS NULL OR payer = ?)
      AND (? IS NULL OR payee = ?)
      AND (? IS NULL OR model = ?)
      AND (? IS NULL OR at >= ?)
      AND (? IS NULL OR at <= ?)
    ORDER BY at ASC
  `);

  const purge = db.prepare(`
    DELETE FROM payment_metrics
    WHERE created_at <= ?
  `);

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async record(...metrics) {
      const now = Date.now();
      transaction(() => {
        for (const metric of metrics) {
          insert.run(
            `${metric.payer}-${metric.payee}-${metric.at}-${Math.random()}`,
            metric.payer,
            metric.payee,
            metric.model,
            metric.amount,
            metric.asset,
            metric.latencyMs,
            metric.outcome,
            metric.at,
            now,
          );
        }
      });
    },

    async query(filter) {
      return (
        selectByFilter.all(
          filter?.payer ?? null,
          filter?.payer ?? null,
          filter?.payee ?? null,
          filter?.payee ?? null,
          filter?.model ?? null,
          filter?.model ?? null,
          filter?.from ?? null,
          filter?.from ?? null,
          filter?.to ?? null,
          filter?.to ?? null,
        ) as Array<{
          id: string;
          payer: string;
          payee: string;
          model: string;
          amount: string;
          asset: string;
          latency_ms: number;
          outcome: string;
          at: string;
        }>
      ).map((row) => ({
        payer: row.payer,
        payee: row.payee,
        model: row.model,
        amount: row.amount,
        asset: row.asset,
        latencyMs: row.latency_ms,
        outcome: row.outcome,
        at: row.at,
      }));
    },

    async purge(olderThan) {
      return Number(purge.run(olderThan).changes);
    },

    close() {
      db.close();
    },
  };
}
