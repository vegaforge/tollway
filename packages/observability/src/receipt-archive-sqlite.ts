/**
 * SQLite receipt archive (#222), using the built-in `node:sqlite` module so it
 * adds no dependency. It passes the same conformance suite as the in-memory
 * archive in `receipt-archive.ts`.
 *
 * Each row keeps the canonical JSON exactly as admitted, next to indexed
 * columns for every filter. Reads parse the canonical JSON again, so a
 * corrupted row is caught before it reaches a caller. `txHash` and
 * `(channelId, sequence)` are columns, so a lookup by settlement reference
 * (#216, #162) uses an index.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  type ArchivePosition,
  admitReceipt,
  assertFilterShape,
  decodeArchiveCursor,
  encodeArchiveCursor,
  positionOf,
  type ReceiptArchive,
  type ReceiptArchiveOptions,
  type ReceiptFilter,
  readStoredReceipt,
  receiptConflict,
  resolveLimit,
  resolveTimeBound,
} from "./receipt-archive.js";
import { loadSqlite } from "./sqlite.js";

export type SqliteReceiptArchiveOptions = ReceiptArchiveOptions & {
  /** Database file path, or `:memory:`. */
  filename: string;
  /**
   * How long a write waits for another connection's lock before it fails.
   * Defaults to 500ms. `node:sqlite` is synchronous, so keep it short.
   */
  busyTimeoutMs?: number;
};

export type SqliteReceiptArchive = ReceiptArchive & {
  /** Closes the underlying database. */
  close(): void;
};

const DEFAULT_BUSY_TIMEOUT_MS = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS archived_receipts (
    id TEXT PRIMARY KEY,
    issued_at_ms INTEGER NOT NULL,
    payer TEXT NOT NULL,
    payee TEXT NOT NULL,
    model TEXT NOT NULL,
    network TEXT NOT NULL,
    asset TEXT NOT NULL,
    resource TEXT NOT NULL,
    tx_hash TEXT,
    channel_id TEXT,
    sequence INTEGER,
    canonical TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS archived_receipts_order ON archived_receipts (issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_payer ON archived_receipts (payer, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_payee ON archived_receipts (payee, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_model ON archived_receipts (model, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_network ON archived_receipts (network, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_asset ON archived_receipts (asset, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_resource ON archived_receipts (resource, issued_at_ms, id);
  CREATE INDEX IF NOT EXISTS archived_receipts_tx_hash ON archived_receipts (tx_hash);
  CREATE INDEX IF NOT EXISTS archived_receipts_channel ON archived_receipts (channel_id, sequence);
`;

type SqlValue = string | number;

/** Builds the WHERE clause for a filter and, optionally, a cursor position. */
function whereClause(
  filter: ReceiptFilter,
  bounds: { from?: number; to?: number },
  after: ArchivePosition | undefined,
): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const equal = (column: string, value: SqlValue | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  equal("payer", filter.payer);
  equal("payee", filter.payee);
  equal("model", filter.model);
  equal("network", filter.network);
  equal("asset", filter.asset);
  equal("resource", filter.resource);
  if (filter.resourcePrefix !== undefined) {
    // instr() counts characters and is exact for any text; the range bound
    // lets the resource index narrow the scan first.
    clauses.push("resource >= ? AND instr(resource, ?) = 1");
    params.push(filter.resourcePrefix, filter.resourcePrefix);
  }
  if (bounds.from !== undefined) {
    clauses.push("issued_at_ms >= ?");
    params.push(bounds.from);
  }
  if (bounds.to !== undefined) {
    clauses.push("issued_at_ms <= ?");
    params.push(bounds.to);
  }
  equal("tx_hash", filter.txHash);
  equal("channel_id", filter.channelId);
  equal("sequence", filter.sequence);
  if (after) {
    clauses.push("(issued_at_ms < ? OR (issued_at_ms = ? AND id < ?))");
    params.push(after.issuedAtMs, after.issuedAtMs, after.id);
  }
  return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function columnsOf(receipt: SignedReceipt): (SqlValue | null)[] {
  const body = receipt.receipt;
  const settlement = body.settlement;
  return [
    body.id,
    Date.parse(body.issuedAt),
    body.payer,
    body.payee,
    body.model,
    body.network,
    body.asset,
    body.resource,
    settlement.kind === "transaction" ? settlement.txHash : null,
    settlement.kind === "channel-commitment" ? settlement.channelId : null,
    settlement.kind === "channel-commitment" ? settlement.sequence : null,
  ];
}

function stringColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`archived_receipts.${name} is not text`);
  }
  return value;
}

/**
 * Opens a SQLite archive. `node:sqlite` is loaded here, not at module load,
 * so an edge runtime that only uses the in-memory archive can still import
 * the package.
 */
export function createSqliteReceiptArchive(
  options: SqliteReceiptArchiveOptions,
): SqliteReceiptArchive {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
  }
  const { DatabaseSync } = loadSqlite("createSqliteReceiptArchive");
  const db = new DatabaseSync(options.filename);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const insert = db.prepare(`
    INSERT INTO archived_receipts (
      id, issued_at_ms, payer, payee, model, network, asset, resource,
      tx_hash, channel_id, sequence, canonical
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const selectCanonical = db.prepare("SELECT canonical FROM archived_receipts WHERE id = ?");

  return {
    async append(candidate) {
      const { receipt, canonical } = await admitReceipt(candidate, options);
      const id = receipt.receipt.id;
      // One statement decides the race between two writers of the same id:
      // the loser inserts nothing and then compares against the winner.
      const result = insert.run(...columnsOf(receipt), canonical);
      if (Number(result.changes) === 1) return "appended";
      const row = selectCanonical.get(id) as Record<string, unknown> | undefined;
      if (row && stringColumn(row, "canonical") === canonical) return "duplicate";
      throw receiptConflict(id);
    },

    async get(id) {
      const row = selectCanonical.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : readStoredReceipt(stringColumn(row, "canonical"), id);
    },

    async search(filter = {}, page = {}) {
      const limit = resolveLimit(page.limit);
      assertFilterShape(filter);
      const bounds = {
        from: resolveTimeBound(filter.from, "from"),
        to: resolveTimeBound(filter.to, "to"),
      };
      const after = page.cursor === undefined ? undefined : decodeArchiveCursor(page.cursor);
      const where = whereClause(filter, bounds, after);
      // One extra row says whether another page exists.
      const rows = db
        .prepare(
          `SELECT id, canonical FROM archived_receipts ${where.sql}
           ORDER BY issued_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(...where.params, limit + 1) as Record<string, unknown>[];

      const items = rows
        .slice(0, limit)
        .map((row) => readStoredReceipt(stringColumn(row, "canonical"), stringColumn(row, "id")));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeArchiveCursor(positionOf(last)) : null,
      };
    },

    close() {
      db.close();
    },
  };
}
