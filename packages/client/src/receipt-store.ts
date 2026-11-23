/**
 * The agent-side receipt store and spend ledger. `pay()` hands each verified
 * receipt to a `ReceiptStore` so an agent can answer "what did I pay for, and
 * how much have I spent per service, asset and model" without keeping the
 * history in a process-local array. See docs/design.md, "Architecture" (agent
 * side), and the "Receipt store and spend ledger" section of the client
 * README.
 *
 * Both backends in this package implement `ReceiptHistory`:
 * `createMemoryReceiptStore` here, and `createSqliteReceiptStore` from
 * `@vegaforge/tollway-client/sqlite`.
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  type SettlementModel,
  type SignedReceipt,
  signedReceiptSchema,
  TollwayError,
  utf8Bytes,
} from "@vegaforge/tollway-core";

/** Most receipts one page holds when the caller does not ask for a size. */
export const DEFAULT_RECEIPT_PAGE_SIZE = 100;

/** Largest page a caller may request, so one query cannot read a whole file. */
export const MAX_RECEIPT_PAGE_SIZE = 1000;

/**
 * Filters a receipt query. Receipts are always settled payments, so there is
 * no outcome filter. Every field is optional and all fields that are set must
 * match.
 */
export type ReceiptFilter = {
  /** Stellar address the payment settled to. */
  payee?: string;
  /** Asset identifier exactly as the receipt carries it. */
  asset?: string;
  model?: SettlementModel;
  /** URL or stable identifier of what was paid for. */
  resource?: string;
  /** Inclusive lower bound on `issuedAt`, ISO 8601 with a zone. */
  from?: string;
  /** Inclusive upper bound on `issuedAt`, ISO 8601 with a zone. */
  to?: string;
};

/** Which slice of a filtered result to return. */
export type ReceiptQueryPage = {
  /** Page size, 1 to {@link MAX_RECEIPT_PAGE_SIZE}. Defaults to 100. */
  limit?: number;
  /** A `nextCursor` from an earlier page. Anything else is rejected. */
  cursor?: string;
};

export type ReceiptQueryResult = {
  /** Newest first, ordered by `issuedAt` descending and then `id` descending. */
  items: SignedReceipt[];
  /** Present while another page exists. Pass it straight back as `cursor`. */
  nextCursor?: string;
};

/**
 * Persists the receipts an agent receives.
 *
 * `put` is idempotent by `receipt.receipt.id`: storing the same receipt twice
 * leaves one row, so a caller may safely replay a write after a crash. The
 * first receipt stored under an id wins; a later `put` with the same id does
 * not replace it.
 */
export interface ReceiptStore {
  put(receipt: SignedReceipt): Promise<void>;
  /** The receipt with this id, or `null` when the store has none. */
  get(id: string): Promise<SignedReceipt | null>;
  /**
   * Receipts matching every filter field, newest first, paginated by a
   * keyset on `(issuedAt, id)`.
   */
  query(filter?: ReceiptFilter, page?: ReceiptQueryPage): Promise<ReceiptQueryResult>;
}

/** Narrows a spend question. Set fields must match; no outcome filter applies. */
export type SpendLedgerQuery = {
  payee?: string;
  asset?: string;
  model?: SettlementModel;
  /** Inclusive lower bound on `issuedAt`, ISO 8601 with a zone. */
  from?: string;
  /** Inclusive upper bound on `issuedAt`, ISO 8601 with a zone. */
  to?: string;
};

/**
 * One asset's spend, as an integer string in that asset's smallest unit.
 * `count` is the number of receipts in the group; `amount` is their sum, which
 * is the sum of what was paid, never an approximate number.
 */
export type SpendTotal = {
  asset: string;
  amount: string;
  count: number;
};

/** Spend to one payee in one asset. */
export type PayeeSpendTotal = SpendTotal & { payee: string };

/** Spend settled through one model in one asset. */
export type ModelSpendTotal = SpendTotal & { model: SettlementModel };

/**
 * Spend totals over a window. Every total is per asset: an amount in USDC and
 * an amount in XLM are never added together, because their smallest units are
 * different sizes.
 */
export type SpendLedgerTotals = {
  byPayeeAsset: PayeeSpendTotal[];
  byModelAsset: ModelSpendTotal[];
};

/** Answers spend questions over the receipts a store holds. */
export interface SpendLedger {
  totals(query?: SpendLedgerQuery): Promise<SpendLedgerTotals>;
}

/** A store that also answers spend questions over the receipts in it. */
export type ReceiptHistory = ReceiptStore & SpendLedger;

/** The keyset a page starts after: the last receipt of the previous page. */
export type ReceiptCursor = {
  issuedAt: string;
  id: string;
};

// A cursor travels as base64url of a two-field JSON object. The check is
// strict: anything the store did not produce is rejected, so a caller that
// edits a cursor gets an error instead of silently moving to another page.
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_FIELDS = new Set(["issuedAt", "id"]);

function invalidCursor(message: string): TollwayError {
  return new TollwayError("invalid-cursor", message);
}

/** Encode the keyset of a page's last receipt as an opaque cursor. */
export function encodeReceiptCursor(cursor: ReceiptCursor): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify({ issuedAt: cursor.issuedAt, id: cursor.id })));
}

/**
 * Decode a cursor produced by {@link encodeReceiptCursor}. A value that is not
 * valid base64url, not JSON, or not exactly `{ issuedAt, id }` throws a
 * `TollwayError` with code `invalid-cursor`.
 */
export function decodeReceiptCursor(cursor: string): ReceiptCursor {
  if (!CURSOR_PATTERN.test(cursor)) {
    throw invalidCursor("cursor is not base64url text");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(base64UrlToBytes(cursor));
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
    throw invalidCursor("cursor does not decode to a receipt keyset");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CURSOR_FIELDS.size || keys.some((key) => !CURSOR_FIELDS.has(key))) {
    throw invalidCursor("cursor does not carry exactly issuedAt and id");
  }
  const { issuedAt, id } = record;
  if (typeof issuedAt !== "string" || issuedAt.length === 0) {
    throw invalidCursor("cursor has no issuedAt");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw invalidCursor("cursor has no id");
  }
  return { issuedAt, id };
}

/**
 * Parse a receipt stored as JSON, or throw. The store is the last place a
 * corrupted row can be caught before an agent acts on it, so a row that does
 * not match `signedReceiptSchema` is an error, never a partial receipt.
 */
export function parseStoredReceipt(value: unknown, context: string): SignedReceipt {
  const parsed = signedReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new TollwayError(
      "corrupt-receipt",
      `${context} does not match the signed receipt schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Page size validated against {@link MAX_RECEIPT_PAGE_SIZE}. */
export function receiptPageLimit(page: ReceiptQueryPage | undefined): number {
  const limit = page?.limit ?? DEFAULT_RECEIPT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECEIPT_PAGE_SIZE) {
    throw new TollwayError(
      "invalid-receipt-query",
      `page limit must be an integer from 1 to ${MAX_RECEIPT_PAGE_SIZE}, got ${String(limit)}`,
    );
  }
  return limit;
}

/**
 * Newest first: `issuedAt` descending, then `id` descending. The same order
 * the SQLite store's `ORDER BY` produces, so one cursor means the same thing
 * in both backends.
 */
export function compareReceiptsDescending(a: ReceiptCursor, b: ReceiptCursor): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** True when `receipt` sorts after `cursor` in the store's newest-first order. */
export function receiptIsAfterCursor(receipt: ReceiptCursor, cursor: ReceiptCursor): boolean {
  if (receipt.issuedAt !== cursor.issuedAt) return receipt.issuedAt < cursor.issuedAt;
  return receipt.id < cursor.id;
}

const RECEIPT_FILTER_FIELDS = ["payee", "asset", "model", "resource"] as const;

/** True when the receipt's body matches every set field of the filter. */
export function receiptMatchesFilter(receipt: SignedReceipt, filter: ReceiptFilter): boolean {
  const body = receipt.receipt;
  for (const field of RECEIPT_FILTER_FIELDS) {
    const expected = filter[field];
    if (expected !== undefined && body[field] !== expected) return false;
  }
  if (filter.from !== undefined && body.issuedAt < filter.from) return false;
  if (filter.to !== undefined && body.issuedAt > filter.to) return false;
  return true;
}

type PayeeAccumulator = {
  payee: string;
  asset: string;
  amount: bigint;
  count: number;
};

type ModelAccumulator = {
  model: SettlementModel;
  asset: string;
  amount: bigint;
  count: number;
};

/** The fields a spend fold needs from one stored receipt. */
export type SpendRow = {
  payee: string;
  asset: string;
  model: SettlementModel;
  amount: string;
};

/**
 * Fold receipt rows into the two breakdowns a `SpendLedgerTotals` carries.
 * Shared by both backends so the memory and SQLite stores cannot disagree,
 * and it sums with `bigint`, so an amount larger than
 * `Number.MAX_SAFE_INTEGER` stays exact.
 */
export function foldSpendRows(rows: Iterable<SpendRow>): SpendLedgerTotals {
  const byPayee = new Map<string, PayeeAccumulator>();
  const byModel = new Map<string, ModelAccumulator>();

  for (const body of rows) {
    let amount: bigint;
    try {
      amount = BigInt(body.amount);
    } catch {
      throw new TollwayError(
        "corrupt-receipt",
        `stored amount ${JSON.stringify(body.amount)} for ${body.payee} -> ${body.asset} is not an integer string`,
      );
    }

    // JSON of an array cannot collide for different field values, unlike a
    // join on a separator that may appear inside an asset code.
    const payeeKey = JSON.stringify([body.payee, body.asset]);
    const payeeTotal = byPayee.get(payeeKey);
    if (payeeTotal) {
      payeeTotal.amount += amount;
      payeeTotal.count += 1;
    } else {
      byPayee.set(payeeKey, { payee: body.payee, asset: body.asset, amount, count: 1 });
    }

    const modelKey = JSON.stringify([body.model, body.asset]);
    const modelTotal = byModel.get(modelKey);
    if (modelTotal) {
      modelTotal.amount += amount;
      modelTotal.count += 1;
    } else {
      byModel.set(modelKey, { model: body.model, asset: body.asset, amount, count: 1 });
    }
  }

  const comparePayee = (a: PayeeAccumulator, b: PayeeAccumulator): number => {
    if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
    if (a.payee === b.payee) return 0;
    return a.payee < b.payee ? -1 : 1;
  };
  const compareModel = (a: ModelAccumulator, b: ModelAccumulator): number => {
    if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
    if (a.model === b.model) return 0;
    return a.model < b.model ? -1 : 1;
  };

  return {
    byPayeeAsset: [...byPayee.values()].sort(comparePayee).map((total) => ({
      payee: total.payee,
      asset: total.asset,
      amount: total.amount.toString(),
      count: total.count,
    })),
    byModelAsset: [...byModel.values()].sort(compareModel).map((total) => ({
      model: total.model,
      asset: total.asset,
      amount: total.amount.toString(),
      count: total.count,
    })),
  };
}

/** Fold full receipts into spend totals; see {@link foldSpendRows}. */
export function foldSpend(receipts: Iterable<SignedReceipt>): SpendLedgerTotals {
  return foldSpendRows([...receipts].map((receipt) => receipt.receipt));
}

/**
 * In-memory {@link ReceiptHistory}. History lasts as long as the process, so
 * it suits tests, short-lived agents and a cache in front of a durable store.
 * For a ledger that survives a restart, use
 * `createSqliteReceiptStore` from `@vegaforge/tollway-client/sqlite`.
 *
 * Reads return a copy, so a caller that mutates a receipt cannot change what
 * the store holds.
 */
export function createMemoryReceiptStore(): ReceiptHistory {
  const receipts = new Map<string, SignedReceipt>();

  return {
    async put(receipt) {
      const parsed = parseStoredReceipt(receipt, "receipt passed to put()");
      const id = parsed.receipt.id;
      if (!receipts.has(id)) {
        receipts.set(id, structuredClone(parsed));
      }
    },
    async get(id) {
      const stored = receipts.get(id);
      return stored ? structuredClone(stored) : null;
    },
    async query(filter = {}, page) {
      const limit = receiptPageLimit(page);
      const cursor = page?.cursor === undefined ? undefined : decodeReceiptCursor(page.cursor);
      const ordered = [...receipts.values()]
        .filter((receipt) => receiptMatchesFilter(receipt, filter))
        .sort((a, b) => compareReceiptsDescending(a.receipt, b.receipt));
      const remaining = cursor
        ? ordered.filter((receipt) => receiptIsAfterCursor(receipt.receipt, cursor))
        : ordered;
      const items = remaining.slice(0, limit).map((receipt) => structuredClone(receipt));
      const last = items.at(-1);
      if (remaining.length > limit && last) {
        return { items, nextCursor: encodeReceiptCursor(last.receipt) };
      }
      return { items };
    },
    async totals(query = {}) {
      const matched: SignedReceipt[] = [];
      for (const receipt of receipts.values()) {
        if (receiptMatchesFilter(receipt, query)) matched.push(receipt);
      }
      return foldSpend(matched);
    },
  };
}
