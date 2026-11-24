/**
 * Receipt archive (#222): an append-only, idempotent store of signed receipts
 * with indexed search and stable keyset pagination. This file ships the
 * in-memory implementation and the shared interface; a SQLite implementation
 * must pass the same contract.
 *
 * Receipts are validated with `signedReceiptSchema` on append and on read. An
 * optional verifier also checks signatures on append; a receipt it cannot
 * verify is never stored.
 */

import {
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
  verifyReceipt,
} from "@vegaforge/tollway-core";

export type ReceiptVerifier = Parameters<typeof verifyReceipt>[1];

export type ReceiptFilter = {
  payer?: string;
  payee?: string;
  model?: SettlementModel;
  network?: StellarNetwork;
  asset?: string;
  /** Exact resource match. */
  resource?: string;
  /** Resource prefix match. */
  resourcePrefix?: string;
  /** Inclusive lower bound on `issuedAt` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `issuedAt` (ISO 8601). */
  to?: string;
  /** Transaction settlement reference. */
  txHash?: string;
  /** Channel settlement reference; combine with `sequence` for one commitment. */
  channelId?: string;
  sequence?: number;
};

export type ArchiveSearchOptions = { limit?: number; cursor?: string };

export type ArchiveSearchResult = {
  items: SignedReceipt[];
  /** Opaque cursor for the next page, or null when the results are exhausted. */
  nextCursor: string | null;
};

export type AppendOutcome = "appended" | "duplicate";

export interface ReceiptArchive {
  /** Idempotent by `receipt.id`. A different body under an existing id throws. */
  append(receipt: SignedReceipt): Promise<AppendOutcome>;
  get(id: string): Promise<SignedReceipt | undefined>;
  search(filter?: ReceiptFilter, options?: ArchiveSearchOptions): Promise<ArchiveSearchResult>;
}

export class ReceiptArchiveError extends Error {
  constructor(
    readonly reason: "invalid-receipt" | "unverifiable-receipt" | "conflict" | "invalid-cursor",
    message: string,
  ) {
    super(message);
    this.name = "ReceiptArchiveError";
  }
}

export const DEFAULT_ARCHIVE_PAGE_SIZE = 50;
export const MAX_ARCHIVE_PAGE_SIZE = 500;

export type MemoryReceiptArchiveOptions = { verifier?: ReceiptVerifier };

type Position = { t: string; i: string };

function encodeCursor(receipt: SignedReceipt): string {
  const position: Position = { t: receipt.issuedAt, i: receipt.id };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ReceiptArchiveError("invalid-cursor", "cursor is not a valid archive cursor");
  }
  const candidate = parsed as Partial<Position>;
  if (typeof candidate?.t !== "string" || typeof candidate?.i !== "string") {
    throw new ReceiptArchiveError("invalid-cursor", "cursor is not a valid archive cursor");
  }
  return { t: candidate.t, i: candidate.i };
}

/** Newest first by (issuedAt, id). */
function compareNewestFirst(a: SignedReceipt, b: SignedReceipt): number {
  const byTime = Date.parse(b.issuedAt) - Date.parse(a.issuedAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when `r` sorts strictly after the cursor position (i.e. is on a later page). */
function isAfterCursor(r: SignedReceipt, position: Position): boolean {
  const cursorTime = Date.parse(position.t);
  const time = Date.parse(r.issuedAt);
  if (time !== cursorTime) return time < cursorTime;
  return r.id < position.i;
}

function matches(r: SignedReceipt, f: ReceiptFilter): boolean {
  if (f.payer !== undefined && r.payer !== f.payer) return false;
  if (f.payee !== undefined && r.payee !== f.payee) return false;
  if (f.model !== undefined && r.model !== f.model) return false;
  if (f.network !== undefined && r.network !== f.network) return false;
  if (f.asset !== undefined && r.asset !== f.asset) return false;
  if (f.resource !== undefined && r.resource !== f.resource) return false;
  if (f.resourcePrefix !== undefined && !r.resource.startsWith(f.resourcePrefix)) return false;
  if (f.from !== undefined && Date.parse(r.issuedAt) < Date.parse(f.from)) return false;
  if (f.to !== undefined && Date.parse(r.issuedAt) > Date.parse(f.to)) return false;
  if (f.txHash !== undefined) {
    if (r.settlement.kind !== "transaction" || r.settlement.txHash !== f.txHash) return false;
  }
  if (f.channelId !== undefined) {
    if (r.settlement.kind !== "channel-commitment") return false;
    if (r.settlement.channelId !== f.channelId) return false;
    if (f.sequence !== undefined && r.settlement.sequence !== f.sequence) return false;
  }
  return true;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ARCHIVE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ReceiptArchiveError("invalid-cursor", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_ARCHIVE_PAGE_SIZE);
}

export function createMemoryReceiptArchive(options: MemoryReceiptArchiveOptions = {}): ReceiptArchive {
  const byId = new Map<string, { receipt: SignedReceipt; canonical: string }>();

  function parse(candidate: unknown): SignedReceipt {
    const parsed = signedReceiptSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ReceiptArchiveError("invalid-receipt", "receipt does not match the Tollway schema");
    }
    return parsed.data;
  }

  return {
    async append(candidate) {
      const receipt = parse(candidate);
      if (options.verifier) {
        const result = await verifyReceipt(receipt, options.verifier);
        if (!result.valid) {
          throw new ReceiptArchiveError(
            "unverifiable-receipt",
            `receipt ${receipt.id} failed verification: ${result.reason}`,
          );
        }
      }
      const canonical = JSON.stringify(receipt);
      const existing = byId.get(receipt.id);
      if (existing) {
        if (existing.canonical === canonical) return "duplicate";
        throw new ReceiptArchiveError(
          "conflict",
          `receipt ${receipt.id} already exists with a different body`,
        );
      }
      byId.set(receipt.id, { receipt, canonical });
      return "appended";
    },

    async get(id) {
      const entry = byId.get(id);
      return entry ? parse(entry.receipt) : undefined;
    },

    async search(filter = {}, pageOptions = {}) {
      const limit = clampLimit(pageOptions.limit);
      const position = pageOptions.cursor !== undefined ? decodeCursor(pageOptions.cursor) : undefined;

      const ordered = [...byId.values()]
        .map((entry) => entry.receipt)
        .filter((r) => matches(r, filter))
        .sort(compareNewestFirst)
        .filter((r) => (position ? isAfterCursor(r, position) : true));

      const items = ordered.slice(0, limit).map((r) => parse(r));
      const hasMore = ordered.length > limit;
      return {
        items,
        nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
      };
    },
  };
}
