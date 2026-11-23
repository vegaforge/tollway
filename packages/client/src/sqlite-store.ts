/**
 * The SQLite receipt store, from `@vegaforge/tollway-client/sqlite`. A
 * separate entry point keeps `node:sqlite` out of the main entry, so the main
 * entry still runs in browsers and edge runtimes.
 *
 * `node:sqlite` ships with Node, so nothing is downloaded or built at install
 * time (CONTRIBUTING.md's security check rejects install scripts). The module
 * is available without a flag from Node 22.13.0; this package therefore
 * requires `>=22.13` in its `engines` field.
 */

import { DatabaseSync } from "node:sqlite";
import { type SignedReceipt, TollwayError } from "@vegaforge/tollway-core";
import {
  decodeReceiptCursor,
  encodeReceiptCursor,
  foldSpendRows,
  parseStoredReceipt,
  type ReceiptHistory,
  type ReceiptQueryPage,
  receiptPageLimit,
  type SpendLedgerQuery,
  type SpendRow,
} from "./receipt-store.js";

/** The schema this build writes. A file from another version is refused. */
export const SQLITE_RECEIPT_SCHEMA_VERSION = 1;

export type SqliteReceiptStoreOptions = {
  /** Database file path, or `":memory:"` for a throwaway database. */
  path: string;
};

/** A SQLite-backed history. `close()` releases the file handle. */
export type SqliteReceiptStore = ReceiptHistory & { close(): void };

type SqlValue = string;

type FilterShape = {
  payee?: string;
  asset?: string;
  model?: string;
  resource?: string;
  from?: string;
  to?: string;
};

function corruptRow(context: string, reason: string): TollwayError {
  return new TollwayError("corrupt-receipt", `${context} is corrupt: ${reason}`);
}

/**
 * The filter as SQL clauses. Every value is bound, never interpolated, so a
 * payee or resource carrying quotes cannot change the statement.
 */
function buildWhere(filter: FilterShape): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const add = (column: string, value: string | undefined, operator = "="): void => {
    if (value === undefined) return;
    clauses.push(`${column} ${operator} ?`);
    params.push(value);
  };
  add("payee", filter.payee);
  add("asset", filter.asset);
  add("model", filter.model);
  add("resource", filter.resource);
  // `issuedAt` is a UTC ISO 8601 string, so a string comparison is a time
  // comparison. Both bounds are inclusive, matching `MetricsQuery`.
  add("issuedAt", filter.from, ">=");
  add("issuedAt", filter.to, "<=");
  if (clauses.length === 0) return { sql: "", params };
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function readSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null || !("version" in row)) {
    throw corruptRow("the schema_version row", "it has no version column");
  }
  const version = (row as { version: unknown }).version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw corruptRow("the schema_version row", `version ${String(version)} is not an integer`);
  }
  return version;
}

function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      issuedAt TEXT NOT NULL,
      payee TEXT NOT NULL,
      asset TEXT NOT NULL,
      model TEXT NOT NULL,
      resource TEXT NOT NULL,
      network TEXT NOT NULL,
      payer TEXT NOT NULL,
      amount TEXT NOT NULL,
      receipt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS receipts_issued_at ON receipts (issuedAt, id);
    CREATE INDEX IF NOT EXISTS receipts_payee ON receipts (payee);
    CREATE INDEX IF NOT EXISTS receipts_asset ON receipts (asset);
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  `);

  const version = readSchemaVersion(db);
  if (version === null) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
      SQLITE_RECEIPT_SCHEMA_VERSION,
    );
  } else if (version !== SQLITE_RECEIPT_SCHEMA_VERSION) {
    db.close();
    throw corruptRow(
      `the receipt store at ${JSON.stringify(path)}`,
      `it uses schema version ${version}, this build writes ${SQLITE_RECEIPT_SCHEMA_VERSION}`,
    );
  }

  return db;
}

function receiptFromRow(row: unknown, context: string): SignedReceipt {
  if (typeof row !== "object" || row === null || !("receipt" in row)) {
    throw corruptRow(context, "the row has no receipt column");
  }
  const text = (row as { receipt: unknown }).receipt;
  if (typeof text !== "string") {
    throw corruptRow(context, "the receipt column is not text");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw corruptRow(context, "the receipt column is not JSON");
  }
  // The schema check on read is what turns a damaged row into an error the
  // caller can see, instead of a half-valid receipt.
  return parseStoredReceipt(json, context);
}

/**
 * A {@link ReceiptHistory} in one SQLite file. Writes are immediate (SQLite's
 * synchronous API), and `put` is idempotent by receipt id, so replaying a
 * write after a crash leaves one row.
 *
 * The store holds the signed receipt and the indexed fields the queries need.
 * It holds no keys and no payment signatures beyond the receipt itself.
 */
export function createSqliteReceiptStore(options: SqliteReceiptStoreOptions): SqliteReceiptStore {
  const db = openStore(options.path);

  return {
    async put(receipt) {
      const parsed = parseStoredReceipt(receipt, "receipt passed to put()");
      const body = parsed.receipt;
      db.prepare(
        `INSERT INTO receipts
           (id, issuedAt, payee, asset, model, resource, network, payer, amount, receipt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        body.id,
        body.issuedAt,
        body.payee,
        body.asset,
        body.model,
        body.resource,
        body.network,
        body.payer,
        body.amount,
        JSON.stringify(parsed),
      );
    },
    async get(id) {
      const row = db.prepare("SELECT receipt FROM receipts WHERE id = ?").get(id);
      if (row === undefined) return null;
      return receiptFromRow(row, `the receipt row for ${JSON.stringify(id)}`);
    },
    async query(filter = {}, page?: ReceiptQueryPage) {
      const limit = receiptPageLimit(page);
      const { sql, params } = buildWhere(filter);
      const cursor = page?.cursor === undefined ? undefined : decodeReceiptCursor(page.cursor);
      const keyset = cursor ? (sql ? " AND" : "WHERE") : "";
      const keysetSql = cursor ? `${keyset} (issuedAt < ? OR (issuedAt = ? AND id < ?))` : "";
      const rows = db
        .prepare(
          `SELECT receipt FROM receipts ${sql}${keysetSql}
           ORDER BY issuedAt DESC, id DESC
           LIMIT ?`,
        )
        .all(
          ...params,
          ...(cursor ? [cursor.issuedAt, cursor.issuedAt, cursor.id] : []),
          limit + 1,
        );

      // One extra row tells us whether another page exists without a count.
      const hasMore = rows.length > limit;
      const items = rows
        .slice(0, limit)
        .map((row, index) => receiptFromRow(row, `the receipt row at position ${index}`));
      const last = items.at(-1);
      if (hasMore && last) {
        return { items, nextCursor: encodeReceiptCursor(last.receipt) };
      }
      return { items };
    },
    async totals(query: SpendLedgerQuery = {}) {
      const { sql, params } = buildWhere(query);
      const rows = db
        .prepare(`SELECT payee, asset, model, amount FROM receipts ${sql}`)
        .all(...params);
      const spendRows = rows.map((row, index): SpendRow => {
        if (
          typeof row !== "object" ||
          row === null ||
          !("payee" in row) ||
          !("asset" in row) ||
          !("model" in row) ||
          !("amount" in row)
        ) {
          throw corruptRow(`the receipt row at position ${index}`, "it is missing a ledger column");
        }
        const record = row as { payee: unknown; asset: unknown; model: unknown; amount: unknown };
        if (
          typeof record.payee !== "string" ||
          typeof record.asset !== "string" ||
          typeof record.amount !== "string" ||
          (record.model !== "x402" &&
            record.model !== "mpp-charge" &&
            record.model !== "mpp-channel")
        ) {
          throw corruptRow(
            `the receipt row at position ${index}`,
            "a ledger column does not hold the value its schema requires",
          );
        }
        return {
          payee: record.payee,
          asset: record.asset,
          model: record.model,
          amount: record.amount,
        };
      });
      return foldSpendRows(spendRows);
    },
    close() {
      db.close();
    },
  };
}
