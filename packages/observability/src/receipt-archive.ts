/**
 * Receipt archive (#222): an append-only, idempotent store of signed receipts
 * with indexed search and stable keyset pagination.
 *
 * This module holds the shared contract (types, filter matching, ordering and
 * the cursor format) and the in-memory implementation. The SQLite
 * implementation in `receipt-archive-sqlite.ts` passes the same conformance
 * suite, so either can back the service's receipts API (#225).
 *
 * Every receipt is checked with `signedReceiptSchema` on append and again on
 * read. The archive stores the canonical JSON of what it was given, never a
 * re-serialised copy of a narrower type, so a later receipt version (#166) is
 * kept exactly. Amounts are never summed here; spend rollups belong to the
 * metrics store.
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  type JsonValue,
  type ReceiptVerifier,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";

/** Search filters. Every field narrows the result; omitted fields match all. */
export type ReceiptFilter = {
  payer?: string;
  payee?: string;
  model?: SettlementModel;
  network?: StellarNetwork;
  asset?: string;
  /** Exact resource match. */
  resource?: string;
  /** Resource prefix match, compared character by character. */
  resourcePrefix?: string;
  /** Inclusive lower bound on `issuedAt` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `issuedAt` (ISO 8601). */
  to?: string;
  /** Transaction settlement reference. */
  txHash?: string;
  /** Channel settlement reference; add `sequence` to select one commitment. */
  channelId?: string;
  sequence?: number;
};

export type ArchiveSearchOptions = {
  /** Page size, 1 to {@link MAX_ARCHIVE_PAGE_SIZE}. Defaults to {@link DEFAULT_ARCHIVE_PAGE_SIZE}. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type ArchiveSearchResult = {
  /** Newest first by `(issuedAt, id)`. */
  items: SignedReceipt[];
  /** Opaque cursor for the next page, or null when the results are exhausted. */
  nextCursor: string | null;
};

/** `appended` for a new receipt, `duplicate` for a byte-identical repeat. */
export type AppendOutcome = "appended" | "duplicate";

export interface ReceiptArchive {
  /**
   * Stores a receipt, idempotent by `receipt.id`. Re-appending an identical
   * receipt returns `duplicate`; a different body under an existing id throws
   * `receipt-conflict` and the stored receipt is kept unchanged.
   */
  append(receipt: unknown): Promise<AppendOutcome>;
  get(id: string): Promise<SignedReceipt | undefined>;
  search(filter?: ReceiptFilter, options?: ArchiveSearchOptions): Promise<ArchiveSearchResult>;
}

export type ReceiptArchiveOptions = {
  /** When set, a receipt is stored only if its signature verifies. */
  verifier?: ReceiptVerifier;
};

export const DEFAULT_ARCHIVE_PAGE_SIZE = 50;
export const MAX_ARCHIVE_PAGE_SIZE = 500;

/**
 * Validates and, when a verifier is configured, verifies a candidate. Returns
 * the parsed receipt and its canonical JSON, which is what gets stored and
 * compared for idempotency.
 */
export async function admitReceipt(
  candidate: unknown,
  options: ReceiptArchiveOptions,
): Promise<{ receipt: SignedReceipt; canonical: string }> {
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `receipt does not match the signed receipt schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (options.verifier) {
    const result = await verifyReceipt(parsed.data, options.verifier);
    if (!result.valid) {
      throw new TollwayError(
        "invalid-receipt",
        `receipt ${parsed.data.receipt.id} failed verification: ${result.reason}`,
      );
    }
  }
  // The schema is strict, so the parsed value carries every field the input
  // had: its canonical JSON is the canonical JSON of what was given.
  return { receipt: parsed.data, canonical: canonicalJson(parsed.data as unknown as JsonValue) };
}

/** The error for a different body under an id that is already stored. */
export function receiptConflict(id: string): TollwayError {
  return new TollwayError(
    "receipt-conflict",
    `receipt ${id} is already archived with a different body; the stored receipt is kept`,
  );
}

/**
 * Parses a stored receipt on read. The archive is the last place a corrupted
 * row can be caught, so a row that no longer matches the schema throws
 * `corrupt-receipt` instead of reaching a caller.
 */
export function readStoredReceipt(canonical: string, id: string): SignedReceipt {
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    throw new TollwayError("corrupt-receipt", `archived receipt ${id} is not valid JSON`);
  }
  const parsed = signedReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new TollwayError(
      "corrupt-receipt",
      `archived receipt ${id} does not match the signed receipt schema`,
    );
  }
  return parsed.data;
}

/** Rejects a limit that is not an integer from 1 to the maximum. */
export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ARCHIVE_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARCHIVE_PAGE_SIZE) {
    throw new TollwayError(
      "invalid-receipt-query",
      `limit must be a whole number from 1 to ${MAX_ARCHIVE_PAGE_SIZE}, got ${limit}`,
    );
  }
  return limit;
}

/** Parses an ISO 8601 bound to epoch milliseconds, or throws. */
export function resolveTimeBound(
  value: string | undefined,
  name: "from" | "to",
): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TollwayError("invalid-receipt-query", `${name} must be an ISO 8601 timestamp`);
  }
  return ms;
}

/** Rejects a `sequence` without a `channelId`, or one that is not a count. */
export function assertFilterShape(filter: ReceiptFilter): void {
  if (filter.sequence !== undefined) {
    if (filter.channelId === undefined) {
      throw new TollwayError("invalid-receipt-query", "sequence needs a channelId");
    }
    if (!Number.isSafeInteger(filter.sequence) || filter.sequence < 0) {
      throw new TollwayError("invalid-receipt-query", "sequence must be a non-negative integer");
    }
  }
}

/** The sort key: newest first by issue time, then by id descending. */
export type ArchivePosition = { issuedAtMs: number; id: string };

export function positionOf(receipt: SignedReceipt): ArchivePosition {
  return { issuedAtMs: Date.parse(receipt.receipt.issuedAt), id: receipt.receipt.id };
}

/**
 * Compares two strings by Unicode code point. That is the order SQLite's
 * default collation gives UTF-8 text, so both implementations page alike;
 * JavaScript's `<` compares UTF-16 units and differs above U+FFFF.
 */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Orders two positions newest first. */
export function compareNewestFirst(a: ArchivePosition, b: ArchivePosition): number {
  if (a.issuedAtMs !== b.issuedAtMs) return b.issuedAtMs - a.issuedAtMs;
  return compareCodePoints(b.id, a.id);
}

/** True when `position` sorts strictly after `cursor`, that is, on a later page. */
export function isAfter(position: ArchivePosition, cursor: ArchivePosition): boolean {
  return compareNewestFirst(cursor, position) < 0;
}

// A cursor travels as base64url of a two-field JSON object, the same format
// the client's receipt store uses. The check is strict: anything the archive
// did not produce is rejected, so an edited cursor is an error instead of a
// silent jump to another page.
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_FIELDS = new Set(["t", "i"]);

function invalidCursor(message: string): TollwayError {
  return new TollwayError("invalid-cursor", message);
}

export function encodeArchiveCursor(position: ArchivePosition): string {
  const json = JSON.stringify({ t: position.issuedAtMs, i: position.id });
  return bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeArchiveCursor(cursor: string): ArchivePosition {
  if (!CURSOR_PATTERN.test(cursor)) throw invalidCursor("cursor is not base64url text");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(cursor));
  } catch {
    throw invalidCursor("cursor is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw invalidCursor("cursor does not decode to JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor("cursor does not decode to an archive position");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CURSOR_FIELDS.size || keys.some((key) => !CURSOR_FIELDS.has(key))) {
    throw invalidCursor("cursor does not carry exactly an issue time and an id");
  }
  const { t, i } = record;
  if (typeof t !== "number" || !Number.isSafeInteger(t)) {
    throw invalidCursor("cursor has no issue time");
  }
  if (typeof i !== "string" || i.length === 0) throw invalidCursor("cursor has no id");
  const position = { issuedAtMs: t, id: i };
  // Re-encoding must give the same text, so two cursors never name one page.
  if (encodeArchiveCursor(position) !== cursor) throw invalidCursor("cursor is not canonical");
  return position;
}

/** True when `receipt` passes every filter. Bounds are epoch milliseconds. */
export function matchesFilter(
  receipt: SignedReceipt,
  filter: ReceiptFilter,
  bounds: { from?: number; to?: number },
): boolean {
  const body = receipt.receipt;
  if (filter.payer !== undefined && body.payer !== filter.payer) return false;
  if (filter.payee !== undefined && body.payee !== filter.payee) return false;
  if (filter.model !== undefined && body.model !== filter.model) return false;
  if (filter.network !== undefined && body.network !== filter.network) return false;
  if (filter.asset !== undefined && body.asset !== filter.asset) return false;
  if (filter.resource !== undefined && body.resource !== filter.resource) return false;
  if (filter.resourcePrefix !== undefined && !body.resource.startsWith(filter.resourcePrefix)) {
    return false;
  }
  const issuedAtMs = Date.parse(body.issuedAt);
  if (bounds.from !== undefined && issuedAtMs < bounds.from) return false;
  if (bounds.to !== undefined && issuedAtMs > bounds.to) return false;
  if (filter.txHash !== undefined) {
    if (body.settlement.kind !== "transaction" || body.settlement.txHash !== filter.txHash) {
      return false;
    }
  }
  if (filter.channelId !== undefined) {
    if (body.settlement.kind !== "channel-commitment") return false;
    if (body.settlement.channelId !== filter.channelId) return false;
    if (filter.sequence !== undefined && body.settlement.sequence !== filter.sequence) return false;
  }
  return true;
}

/** An in-memory archive, for tests, demos and single-process services. */
export function createMemoryReceiptArchive(options: ReceiptArchiveOptions = {}): ReceiptArchive {
  const byId = new Map<string, string>();

  return {
    async append(candidate) {
      const { receipt, canonical } = await admitReceipt(candidate, options);
      const existing = byId.get(receipt.receipt.id);
      if (existing !== undefined) {
        if (existing === canonical) return "duplicate";
        throw receiptConflict(receipt.receipt.id);
      }
      byId.set(receipt.receipt.id, canonical);
      return "appended";
    },

    async get(id) {
      const canonical = byId.get(id);
      return canonical === undefined ? undefined : readStoredReceipt(canonical, id);
    },

    async search(filter = {}, page = {}) {
      const limit = resolveLimit(page.limit);
      assertFilterShape(filter);
      const bounds = {
        from: resolveTimeBound(filter.from, "from"),
        to: resolveTimeBound(filter.to, "to"),
      };
      const after = page.cursor === undefined ? undefined : decodeArchiveCursor(page.cursor);

      const ordered: SignedReceipt[] = [];
      for (const [id, canonical] of byId) {
        const receipt = readStoredReceipt(canonical, id);
        if (!matchesFilter(receipt, filter, bounds)) continue;
        if (after && !isAfter(positionOf(receipt), after)) continue;
        ordered.push(receipt);
      }
      ordered.sort((a, b) => compareNewestFirst(positionOf(a), positionOf(b)));

      const items = ordered.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: ordered.length > limit && last ? encodeArchiveCursor(positionOf(last)) : null,
      };
    },
  };
}
