/**
 * Typed data layer for the receipts archive view.
 *
 * The receipts view depends on @vegaforge/tollway-observability, tracked in
 * issue #31. Until that lands this module is the single seam the UI talks
 * through. Replacing the body of `fetchReceipts` with a real call to the
 * observability hub is a one-import change; everything downstream (the row
 * shape, the query contract, the pagination, the detail view) stays the same.
 *
 * Trust model: the caller supplies a `keySetSource`. The stub returns a URL
 * that resolves to a JWKS-style object; a real implementation reads from a
 * well-known URL published by the service (#167, #225). Keeping keys separate
 * from receipts means a compromised receipt source cannot manufacture a
 * matching key and pass verification.
 *
 * See docs/design.md, "One receipt format" and "Observability".
 */

import {
  buildReceipt,
  Ed25519Signer,
  type ReceiptBody,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";

/** One row in the receipts archive. The row is the full SignedReceipt. */
export type ReceiptRow = SignedReceipt;

/**
 * Filters for the receipt archive query. All fields are optional; omitting a
 * field means no filter on that dimension.
 */
export type ReceiptQuery = {
  /** Free-text search over id, payer, payee, resource, and txHash / channelId. */
  search?: string;
  /** Restrict to one payer address. */
  payer?: string;
  /** Restrict to one payee address. */
  payee?: string;
  /** Restrict to one model. */
  model?: ReceiptBody["model"];
  /** Restrict to one asset (the full asset string, e.g. "USDC:GA5Z…"). */
  asset?: string;
  /** Restrict to one network ("testnet" | "mainnet" etc.). */
  network?: string;
  /** Only receipts for resources whose path starts with this string. */
  resourcePrefix?: string;
  /** ISO-8601: only receipts issued on or after this instant. */
  from?: string;
  /** ISO-8601: only receipts issued before this instant. */
  to?: string;
  /** Filter to receipts whose settlement txHash equals this value. */
  txHash?: string;
  /** Filter to receipts whose settlement channelId equals this value. */
  channelId?: string;
  /**
   * The id of the last receipt on the previous page (newest-first order),
   * or null / undefined for the first page.
   */
  cursor?: string | null;
  /** Number of rows to return. Defaults to DEFAULT_RECEIPT_PAGE_SIZE. */
  limit?: number;
};

/** One page of receipts returned by the data source. */
export type ReceiptsPage = {
  rows: ReceiptRow[];
  /**
   * Pass to the next query as `cursor` to load the next page, or null when
   * this is the last page.
   */
  nextCursor: string | null;
};

/**
 * Metadata about the key set used to verify receipts.
 * Returned separately from the rows so the detail panel can state the source.
 */
export type KeySetInfo = {
  /** Human-readable name of the source, e.g. the URL. */
  source: string;
  /** Raw Ed25519 public-key bytes, keyed by keyId. */
  keys: Record<string, Uint8Array>;
};

export const DEFAULT_RECEIPT_PAGE_SIZE = 20;
const MAX_RECEIPT_PAGE_SIZE = 100;

/**
 * The single seam between the dashboard and the receipt archive.
 *
 * Returns one page of receipts matching `query` and the key-set info
 * needed to verify them. The key-set comes from `keySetSource`, not from
 * the same call that returns the rows, so they cannot be forged together.
 */
export async function fetchReceipts(query: ReceiptQuery = {}): Promise<{
  page: ReceiptsPage;
  keySet: KeySetInfo;
}> {
  const stub = await getStub();
  const page = applyQuery(stub.rows, query);
  return { page, keySet: stub.keySet };
}

// ── stub cache ────────────────────────────────────────────────────────────────

type StubData = { rows: ReceiptRow[]; keySet: KeySetInfo };
let stubCache: StubData | null = null;

async function getStub(): Promise<StubData> {
  stubCache ??= await buildStub();
  return stubCache;
}

// ── query engine ──────────────────────────────────────────────────────────────

function applyQuery(allRows: ReceiptRow[], query: ReceiptQuery): ReceiptsPage {
  const limit = resolveLimit(query.limit);
  const search = query.search?.toLowerCase().trim();

  const matching = allRows.filter((sr) => {
    const r = sr.receipt;

    if (query.payer !== undefined && r.payer !== query.payer) return false;
    if (query.payee !== undefined && r.payee !== query.payee) return false;
    if (query.model !== undefined && r.model !== query.model) return false;
    if (query.asset !== undefined && r.asset !== query.asset) return false;
    if (query.network !== undefined && r.network !== query.network) return false;
    if (query.resourcePrefix !== undefined && !r.resource.startsWith(query.resourcePrefix))
      return false;
    if (query.from !== undefined && r.issuedAt < query.from) return false;
    if (query.to !== undefined && r.issuedAt >= query.to) return false;
    if (query.txHash !== undefined) {
      if (r.settlement.kind !== "transaction" || r.settlement.txHash !== query.txHash) return false;
    }
    if (query.channelId !== undefined) {
      if (r.settlement.kind !== "channel-commitment" || r.settlement.channelId !== query.channelId)
        return false;
    }

    if (search) {
      const settlementText =
        r.settlement.kind === "transaction"
          ? r.settlement.txHash
          : `${r.settlement.channelId} ${r.settlement.sequence}`;
      const haystack =
        `${r.id} ${r.payer} ${r.payee} ${r.resource} ${settlementText}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });

  // Find the cursor position (newest-first; cursor is the id of the last row
  // on the previous page).
  let start = 0;
  if (query.cursor !== undefined && query.cursor !== null) {
    const idx = matching.findIndex((sr) => sr.receipt.id === query.cursor);
    if (idx === -1) throw new RangeError(`cursor "${query.cursor}" is not in this result set`);
    start = idx + 1;
  }

  const rows = matching.slice(start, start + limit);
  const hasMore = start + limit < matching.length;
  return { rows, nextCursor: hasMore ? (rows.at(-1)?.receipt.id ?? null) : null };
}

function resolveLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_RECEIPT_PAGE_SIZE;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_RECEIPT_PAGE_SIZE) {
    throw new RangeError(
      `limit must be a whole number from 1 to ${MAX_RECEIPT_PAGE_SIZE}, got ${raw}`,
    );
  }
  return raw;
}

// ── deterministic fixture ─────────────────────────────────────────────────────
//
// At least 60 receipts across all three models and two assets, newest first.

const ISSUER_USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER_XLM = "XLM:GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2BO3MHNKZASZCERHXANDER";
const STUB_KEY_ID = "tollway-stub-2026";
const STUB_KEY_SET_URL = "/.well-known/tollway-keys.json";

const PAYERS = [
  "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "GAGENTSUMMARIZERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "GAGENTCLASSIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "GAGENTROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
];
const PAYEES = [
  "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "GOPENAIXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
];
const MODELS: Array<ReceiptBody["model"]> = ["x402", "mpp-charge", "mpp-channel"];
const ASSETS = [ISSUER_USDC, ISSUER_XLM];
const NETWORKS = ["testnet", "mainnet"] as const;
const RESOURCES = [
  "/quotes/latest",
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/images/generations",
];

type SeedReceipt = Parameters<typeof buildReceipt>[0] & {
  id: string;
  issuedAt: string;
};

async function buildStub(): Promise<StubData> {
  const signer = await Ed25519Signer.generate(STUB_KEY_ID);

  // The original named receipts are kept at the top (most recent timestamps)
  // so downstream code that references them by id continues to work.
  const NAMED_BASE_MS = Date.parse("2026-06-29T14:00:00.000Z");
  const namedSeeds: SeedReceipt[] = [
    {
      id: "rcpt-x402-stripe-01",
      issuedAt: "2026-06-29T13:55:12.000Z",
      payer: "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "120000",
      asset: ISSUER_USDC,
      resource: "/quotes/latest",
      model: "x402",
      settlement: {
        kind: "transaction",
        txHash: "ad21ce4f9e1f3b2a8e7c0d1f2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5",
      },
      network: "testnet",
    },
    {
      id: "rcpt-x402-v2-stripe-02",
      issuedAt: new Date(NAMED_BASE_MS + 500_000).toISOString(), // newest
      payer: "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "120000",
      asset: ISSUER_USDC,
      resource: "/quotes/latest",
      model: "x402",
      settlement: {
        kind: "transaction",
        txHash: "c4e1a0b2d3f4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
      },
      network: "testnet",
      offerHash: "Yp2N0cP8dQe3m4L6vK1sT9wR7uX5zA0bC2dE4fG6hI8",
      method: "GET" as const,
    },
    {
      id: "rcpt-mppcharge-anthropic-01",
      issuedAt: "2026-06-29T13:48:00.000Z",
      payer: "GAGENTSUMMARIZERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "750000",
      asset: ISSUER_USDC,
      resource: "/v1/messages",
      model: "mpp-charge",
      settlement: {
        kind: "transaction",
        txHash: "be32df50a8203f3b9c8d1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f2a3",
      },
      network: "testnet",
    },
    {
      id: "rcpt-channel-openai-01",
      issuedAt: "2026-06-29T13:30:00.000Z",
      payer: "GAGENTCLASSIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GOPENAIXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "8500000",
      asset: ISSUER_USDC,
      resource: "/v1/chat/completions",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-openai-03", sequence: 96 },
      network: "testnet",
    },
    {
      id: "rcpt-channel-anthropic-01",
      issuedAt: "2026-06-29T12:10:00.000Z",
      payer: "GAGENTROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "4100000",
      asset: ISSUER_USDC,
      resource: "/v1/messages",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-anthropic-02", sequence: 187 },
      network: "testnet",
    },
  ];

  // Generated bulk seeds provide the remaining volume (at least 60 total).
  const BASE_MS = Date.parse("2026-06-29T11:00:00.000Z"); // older than the named set
  const seeds: SeedReceipt[] = [...namedSeeds];

  let idx = 0;
  for (let i = 0; i < 60; i += 1) {
    const model = MODELS[i % MODELS.length] as ReceiptBody["model"];
    const asset = ASSETS[i % ASSETS.length] as string;
    const payer = PAYERS[i % PAYERS.length] as string;
    const payee = PAYEES[i % PAYEES.length] as string;
    const resource = RESOURCES[i % RESOURCES.length] as string;
    const network = NETWORKS[i % NETWORKS.length] ?? "testnet";
    const issuedAt = new Date(BASE_MS - i * 300_000).toISOString(); // 5-min steps

    const baseAmount = BigInt(100_000 + i * 50_000);

    // Vary the settlement by model.
    if (model === "mpp-channel") {
      seeds.push({
        id: `rcpt-stub-${String(idx).padStart(3, "0")}`,
        issuedAt,
        payer,
        payee,
        amount: (baseAmount * 10n).toString(),
        asset,
        resource,
        model,
        settlement: {
          kind: "channel-commitment",
          channelId: `ch-stub-${String(i % 5).padStart(2, "0")}`,
          sequence: i * 3 + 1,
        },
        network,
      });
    } else if (i % 7 === 0) {
      // A few v2 receipts (x402 and mpp-charge can carry offerHash / method).
      seeds.push({
        id: `rcpt-stub-${String(idx).padStart(3, "0")}`,
        issuedAt,
        payer,
        payee,
        amount: baseAmount.toString(),
        asset,
        resource,
        model,
        settlement: {
          kind: "transaction",
          txHash: `a${idx.toString(16).padStart(63, "0")}`,
        },
        network,
        offerHash: `offerHash${i}`,
        method: "GET" as const,
      });
    } else {
      seeds.push({
        id: `rcpt-stub-${String(idx).padStart(3, "0")}`,
        issuedAt,
        payer,
        payee,
        amount: baseAmount.toString(),
        asset,
        resource,
        model,
        settlement: {
          kind: "transaction",
          txHash: `b${idx.toString(16).padStart(63, "0")}`,
        },
        network,
      });
    }
    idx += 1;
  }

  // Sort newest first (issuedAt descending).
  seeds.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

  const rows = await Promise.all(
    seeds.map(async (seed) => signReceipt(buildReceipt(seed), signer)),
  );

  return {
    rows,
    keySet: {
      source: STUB_KEY_SET_URL,
      keys: { [signer.keyId]: signer.publicKey },
    },
  };
}
