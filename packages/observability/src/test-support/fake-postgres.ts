import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { toAnonymousPlaceholders } from "../metrics-sql.js";
import type { PostgresLikeClient } from "../postgres-metrics-store.js";

/**
 * A test double for a Postgres client. It runs the Postgres metrics store's
 * own SQL against an in-memory SQLite database, translating the few
 * Postgres-only pieces that store uses:
 *
 * - `$1` placeholders become SQLite's anonymous `?`, in order;
 * - `BIGSERIAL`, `NUMERIC(78, 0)` and `DOUBLE PRECISION` become SQLite types;
 * - `SUM(amount)::text` becomes a list of the amounts, summed here with
 *   bigint, because SQLite's SUM is not exact for large integers and
 *   Postgres's NUMERIC sum is;
 * - `COUNT(*)` and `position` come back as strings, as `pg` returns int8.
 *
 * It also records every statement, so a test can check what the store sent.
 */
export function createFakePostgres(): PostgresLikeClient & {
  statements: string[];
  db: DatabaseSync;
} {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  return {
    db,
    statements,
    async query(text, params = []) {
      statements.push(text);
      const anonymous = toAnonymousPlaceholders(text, params);
      const sql = anonymous.sql
        .replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
        .replace(/NUMERIC\(78, 0\)/g, "TEXT")
        .replace(/DOUBLE PRECISION/g, "REAL")
        .replace(/SUM\(amount\)::text/g, "group_concat(amount, ',')");
      const statement = db.prepare(sql);
      if (!/^\s*SELECT/i.test(sql)) {
        statement.run(...(anonymous.params as SQLInputValue[]));
        return { rows: [] };
      }
      const rows = statement.all(...(anonymous.params as SQLInputValue[])).map((row) => {
        const out: Record<string, unknown> = { ...row };
        // The store aliases every sum as `total`; here it is a list of amounts.
        if (typeof out.total === "string") {
          out.total = out.total
            .split(",")
            .reduce((sum, amount) => sum + BigInt(amount), 0n)
            .toString();
        }
        if (out.n !== undefined) out.n = String(out.n);
        if (out.position !== undefined) out.position = String(out.position);
        return out;
      });
      return { rows };
    },
  };
}
