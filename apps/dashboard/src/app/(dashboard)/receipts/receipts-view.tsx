"use client";

import {
  Ed25519Verifier,
  type ReceiptBody,
  type ReceiptVerification,
  type SettlementRef,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import type { KeySetInfo, ReceiptQuery } from "@/data/receipts";
import { useReceipts } from "@/data/use-receipts";
import { formatAmount } from "@/lib/amount";

// ── constants ─────────────────────────────────────────────────────────────────

const MODEL_LABEL: Record<ReceiptBody["model"], string> = {
  x402: "x402",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

const MODELS: Array<ReceiptBody["model"]> = ["x402", "mpp-charge", "mpp-channel"];

const selectClass =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

const inputClass =
  "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

// ── URL param helpers ─────────────────────────────────────────────────────────

function parseParams(params: URLSearchParams): {
  search: string;
  payer: string;
  payee: string;
  model: string;
  asset: string;
  network: string;
  from: string;
  to: string;
  cursor: string | null;
} {
  return {
    search: params.get("search") ?? "",
    payer: params.get("payer") ?? "",
    payee: params.get("payee") ?? "",
    model: params.get("model") ?? "",
    asset: params.get("asset") ?? "",
    network: params.get("network") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    cursor: params.get("cursor") ?? null,
  };
}

function buildQuery(parsed: ReturnType<typeof parseParams>): ReceiptQuery {
  const q: ReceiptQuery = {};
  if (parsed.search) q.search = parsed.search;
  if (parsed.payer) q.payer = parsed.payer;
  if (parsed.payee) q.payee = parsed.payee;
  if (parsed.model) q.model = parsed.model as ReceiptBody["model"];
  if (parsed.asset) q.asset = parsed.asset;
  if (parsed.network) q.network = parsed.network;
  if (parsed.from) q.from = parsed.from;
  if (parsed.to) q.to = parsed.to;
  if (parsed.cursor) q.cursor = parsed.cursor;
  return q;
}

function hasActiveFilters(parsed: ReturnType<typeof parseParams>): boolean {
  return !!(
    parsed.search ||
    parsed.payer ||
    parsed.payee ||
    parsed.model ||
    parsed.asset ||
    parsed.network ||
    parsed.from ||
    parsed.to
  );
}

function describeActiveFilters(parsed: ReturnType<typeof parseParams>): string {
  const parts: string[] = [];
  if (parsed.search) parts.push(`search "${parsed.search}"`);
  if (parsed.payer) parts.push(`payer ${truncate(parsed.payer, 8, 6)}`);
  if (parsed.payee) parts.push(`payee ${truncate(parsed.payee, 8, 6)}`);
  if (parsed.model)
    parts.push(`model ${MODEL_LABEL[parsed.model as ReceiptBody["model"]] ?? parsed.model}`);
  if (parsed.asset) parts.push(`asset ${assetCode(parsed.asset)}`);
  if (parsed.network) parts.push(`network ${parsed.network}`);
  if (parsed.from) parts.push(`from ${parsed.from.slice(0, 10)}`);
  if (parsed.to) parts.push(`to ${parsed.to.slice(0, 10)}`);
  return parts.join(", ");
}

// ── utilities ─────────────────────────────────────────────────────────────────

function truncate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function assetCode(asset: string): string {
  return asset.split(":")[0] ?? asset;
}

function settlementSummary(ref: SettlementRef): string {
  if (ref.kind === "transaction") {
    return `tx ${truncate(ref.txHash, 8, 6)}`;
  }
  return `${ref.channelId} · seq ${ref.sequence}`;
}

// ── main view ─────────────────────────────────────────────────────────────────

/**
 * `payee` limits the archive to receipts paid to one counterparty. The
 * anomaly feed links here with it. When set, the filter bar is hidden and
 * the payee filter is shown as a banner instead.
 */
export function ReceiptsView({ payee = null }: { payee?: string | null }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const parsed = useMemo(() => parseParams(params), [params]);

  // If a payee prop is provided (from the anomaly feed), override the URL
  // payee filter silently.
  const effectiveParsed = useMemo(
    () => (payee !== null ? { ...parsed, payee } : parsed),
    [parsed, payee],
  );

  const query = useMemo(() => buildQuery(effectiveParsed), [effectiveParsed]);
  const state = useReceipts(query);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = state.status === "ready" ? state.page.rows : [];
  const keySet = state.status === "ready" ? state.keySet : null;

  const selected = useMemo(
    () => rows.find((row) => row.receipt.id === selectedId) ?? null,
    [rows, selectedId],
  );

  // Push a URL update. Filter changes reset the cursor.
  const pushParams = useCallback(
    (updates: Partial<ReturnType<typeof parseParams>>, resetCursor = true) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "" || value === undefined) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      if (resetCursor) next.delete("cursor");
      router.push(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams();
    if (payee === null && params.get("payee")) {
      // keep payee if it came from the banner, not the bar
    }
    router.push(`${pathname}?${next.toString()}`);
  }, [params, pathname, payee, router]);

  const nextCursor = state.status === "ready" ? state.page.nextCursor : null;
  const isFirstPage = !effectiveParsed.cursor;

  return (
    <Panel
      title="Receipts"
      description="Signed receipt archive: searchable, filterable, and paginated."
    >
      {/* Payee-filter banner (from anomaly feed) */}
      {payee !== null ? (
        <p data-testid="receipts-payee-filter" className="mb-4 text-sm">
          Paid to <span className="font-mono">{payee}</span>.{" "}
          <Link className="underline" href="/receipts">
            Show all receipts
          </Link>
        </p>
      ) : null}

      {/* Filter bar — hidden when a payee prop locks the view */}
      {payee === null ? (
        <div
          data-testid="receipts-filter-bar"
          className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {/* Free-text search */}
          <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
            Search
            <input
              type="search"
              aria-label="Search receipts"
              placeholder="id, payer, payee, resource, tx hash…"
              className={inputClass}
              value={parsed.search}
              onChange={(e) => pushParams({ search: e.target.value })}
            />
          </label>

          {/* Model filter */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            Model
            <select
              aria-label="Model"
              className={selectClass}
              value={parsed.model}
              onChange={(e) => pushParams({ model: e.target.value })}
            >
              <option value="">All models</option>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </label>

          {/* Network filter */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            Network
            <select
              aria-label="Network"
              className={selectClass}
              value={parsed.network}
              onChange={(e) => pushParams({ network: e.target.value })}
            >
              <option value="">All networks</option>
              <option value="testnet">testnet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </label>

          {/* Payer filter */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            Payer
            <input
              type="text"
              aria-label="Payer address"
              placeholder="Stellar address…"
              className={inputClass}
              value={parsed.payer}
              onChange={(e) => pushParams({ payer: e.target.value })}
            />
          </label>

          {/* Payee filter */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            Payee
            <input
              type="text"
              aria-label="Payee address"
              placeholder="Stellar address…"
              className={inputClass}
              value={parsed.payee}
              onChange={(e) => pushParams({ payee: e.target.value })}
            />
          </label>

          {/* From date */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            From (UTC)
            <input
              type="datetime-local"
              aria-label="From date"
              className={inputClass}
              value={parsed.from ? parsed.from.slice(0, 16) : ""}
              onChange={(e) =>
                pushParams({ from: e.target.value ? `${e.target.value}:00.000Z` : "" })
              }
            />
          </label>

          {/* To date */}
          <label className="flex flex-col gap-1 text-xs text-muted">
            To (UTC)
            <input
              type="datetime-local"
              aria-label="To date"
              className={inputClass}
              value={parsed.to ? parsed.to.slice(0, 16) : ""}
              onChange={(e) =>
                pushParams({ to: e.target.value ? `${e.target.value}:00.000Z` : "" })
              }
            />
          </label>
        </div>
      ) : null}

      {/* Loading / error */}
      {state.status === "loading" ? <ReceiptsTableSkeleton /> : null}
      {state.status === "error" ? <ReceiptsTableError error={state.error} /> : null}

      {/* Ready */}
      {state.status === "ready" ? (
        rows.length === 0 ? (
          hasActiveFilters(effectiveParsed) || payee !== null ? (
            <EmptyState
              data-testid="receipts-empty-filtered"
              title="No receipts match these filters"
              body={`Active filters: ${describeActiveFilters(effectiveParsed) || `payee ${payee ?? ""}`}.`}
              action={
                payee === null ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-2 text-sm underline hover:text-foreground"
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          ) : (
            <p className="text-sm text-muted">
              No receipts yet. Wire a paid route and the archive will populate.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-6">
            <ReceiptsTable
              rows={rows}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />

            {/* Pagination */}
            <nav aria-label="Receipt pages" className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => pushParams({ cursor: null }, false)}
                disabled={isFirstPage}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
              >
                Newer
              </button>
              <button
                type="button"
                onClick={() => {
                  if (nextCursor !== null) pushParams({ cursor: nextCursor }, false);
                }}
                disabled={nextCursor === null}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
              >
                Older
              </button>
            </nav>

            {/* Detail panel */}
            {selected && keySet ? (
              <ReceiptDetail receipt={selected} keySet={keySet} />
            ) : (
              <p className="text-xs text-muted">
                Select a row to expand the signed receipt, verify its signature, and follow the
                settlement reference.
              </p>
            )}
          </div>
        )
      ) : null}
    </Panel>
  );
}

// ── table ─────────────────────────────────────────────────────────────────────

function ReceiptsTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: SignedReceipt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Payer
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Payee
            </th>
            <th scope="col" className="px-3 py-2 font-medium text-right">
              Amount
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Model
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Settlement
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ receipt }) => {
            const isSelected = receipt.id === selectedId;
            return (
              <tr
                key={receipt.id}
                data-testid={`receipt-row-${receipt.id}`}
                data-selected={isSelected ? "true" : undefined}
                onClick={() => onSelect(receipt.id)}
                className={`cursor-pointer border-b border-border last:border-b-0 transition-colors ${
                  isSelected ? "bg-accent/5" : "hover:bg-surface-2"
                }`}
              >
                <td className="px-3 py-3">
                  <button
                    type="button"
                    data-testid={`receipt-select-${receipt.id}`}
                    aria-pressed={isSelected}
                    className="block rounded font-mono text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span className="sr-only">Select receipt {receipt.id}, payer </span>
                    {truncate(receipt.payer, 8, 6)}
                  </button>
                </td>
                <td className="px-3 py-3">
                  <span className="block font-mono text-xs text-muted">
                    {truncate(receipt.payee, 8, 6)}
                  </span>
                </td>
                <td className="px-3 py-3 text-right font-mono">
                  {formatAmount(receipt.amount, receipt.asset)}
                </td>
                <td className="px-3 py-3">
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                    {MODEL_LABEL[receipt.model]}
                  </span>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-muted">
                  {settlementSummary(receipt.settlement)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── detail panel ──────────────────────────────────────────────────────────────

function ReceiptDetail({ receipt, keySet }: { receipt: SignedReceipt; keySet: KeySetInfo }) {
  const [verification, setVerification] = useState<
    | { status: "verifying" }
    | { status: "unknown-key" }
    | { status: "verified"; result: ReceiptVerification; keyId: string; keySetSource: string }
    | { status: "error"; error: Error }
  >({ status: "verifying" });

  useEffect(() => {
    let cancelled = false;
    setVerification({ status: "verifying" });

    const keyId = receipt.signature.keyId;

    // Check whether the key is in the trusted set before attempting
    // verification; unknown keys are distinct from invalid signatures.
    if (!(keyId in keySet.keys)) {
      if (!cancelled) setVerification({ status: "unknown-key" });
      return () => {
        cancelled = true;
      };
    }

    const verifier = new Ed25519Verifier(keySet.keys);
    verifyReceipt(receipt, verifier)
      .then((result) => {
        if (cancelled) return;
        setVerification({
          status: "verified",
          result,
          keyId,
          keySetSource: keySet.source,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setVerification({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [receipt, keySet]);

  const json = JSON.stringify(receipt, null, 2);

  return (
    <section
      data-testid={`receipt-detail-${receipt.receipt.id}`}
      className="rounded-lg border border-border bg-surface-2 p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Receipt</p>
          <p className="font-mono text-sm">{receipt.receipt.id}</p>
        </div>
        <VerificationPill verification={verification} />
      </header>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Detail label="Payer" value={receipt.receipt.payer} mono />
        <Detail label="Payee" value={receipt.receipt.payee} mono />
        <Detail
          label="Amount"
          value={formatAmount(receipt.receipt.amount, receipt.receipt.asset)}
        />
        <Detail label="Model" value={MODEL_LABEL[receipt.receipt.model]} />
        <Detail label="Resource" value={receipt.receipt.resource} mono />
        <Detail label="Network" value={receipt.receipt.network} />
        <Detail label="Issued at" value={receipt.receipt.issuedAt} mono />
        <SettlementDetail settlement={receipt.receipt.settlement} />
        <Detail label="Version" value={String(receipt.receipt.version)} />
        {receipt.receipt.version === 2 ? (
          <>
            <Detail label="Method" value={receipt.receipt.method} mono />
            <Detail label="Offer hash" value={receipt.receipt.offerHash} mono />
            <Detail
              label="Expires at"
              value={receipt.receipt.expiresAt ?? "Never"}
              mono={receipt.receipt.expiresAt !== undefined}
            />
          </>
        ) : null}
      </dl>

      <footer className="mt-4 border-t border-border pt-3">
        <p className="text-xs uppercase tracking-wide text-muted">Signature</p>
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Detail label="Key id" value={receipt.signature.keyId} mono />
          <Detail label="Algorithm" value={receipt.signature.algorithm} />
          {verification.status === "verified" ? (
            <div className="sm:col-span-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted">Key set</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-muted">
                {verification.keySetSource}
              </dd>
            </div>
          ) : null}
        </dl>
        <p
          className="mt-2 break-all font-mono text-[11px] text-muted"
          data-testid="receipt-signature-value"
        >
          {receipt.signature.value}
        </p>
      </footer>

      {/* Copy / download actions */}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <CopyButton json={json} />
        <DownloadButton json={json} id={receipt.receipt.id} />
      </div>
    </section>
  );
}

function CopyButton({ json }: { json: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="receipt-copy-json"
      onClick={() => {
        void navigator.clipboard.writeText(json).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface"
    >
      {copied ? "Copied!" : "Copy receipt JSON"}
    </button>
  );
}

function DownloadButton({ json, id }: { json: string; id: string }) {
  return (
    <a
      data-testid="receipt-download-json"
      href={`data:application/json,${encodeURIComponent(json)}`}
      download={`receipt-${id}.json`}
      className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface"
    >
      Download
    </a>
  );
}

// ── detail sub-components ─────────────────────────────────────────────────────

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : "text-sm"}`}>{value}</dd>
    </div>
  );
}

function SettlementDetail({ settlement }: { settlement: SettlementRef }) {
  if (settlement.kind === "transaction") {
    return <Detail label="Settlement (tx)" value={settlement.txHash} mono />;
  }
  return (
    <div className="sm:col-span-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted">Settlement (channel)</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-2 font-mono text-xs">
        <Link
          href={`/channels/${encodeURIComponent(settlement.channelId)}`}
          data-testid="receipt-channel-link"
          className="text-accent underline hover:no-underline"
        >
          {settlement.channelId}
        </Link>
        <span className="text-muted">· seq {settlement.sequence}</span>
      </dd>
    </div>
  );
}

function VerificationPill({
  verification,
}: {
  verification:
    | { status: "verifying" }
    | { status: "unknown-key" }
    | { status: "verified"; result: ReceiptVerification; keyId: string; keySetSource: string }
    | { status: "error"; error: Error };
}) {
  if (verification.status === "verifying") {
    return (
      <span
        data-testid="receipt-verification-verifying"
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted"
      >
        Verifying…
      </span>
    );
  }
  if (verification.status === "unknown-key") {
    return (
      <span
        data-testid="receipt-verification-unknown-key"
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted"
      >
        Unknown signing key
      </span>
    );
  }
  if (verification.status === "error") {
    return (
      <span
        data-testid="receipt-verification-error"
        className="inline-flex items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground"
        title={verification.error.message}
      >
        Verification error
      </span>
    );
  }
  if (verification.result.valid) {
    return (
      <span
        data-testid="receipt-verification-valid"
        className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground"
        title={`Verified against key ${verification.keyId} from ${verification.keySetSource}`}
      >
        Signature valid
      </span>
    );
  }
  return (
    <span
      data-testid="receipt-verification-invalid"
      className="inline-flex items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground"
      title={verification.result.reason}
    >
      Signature invalid
    </span>
  );
}

// ── skeletons / errors ────────────────────────────────────────────────────────

function ReceiptsTableSkeleton() {
  return (
    <div className="space-y-2" data-testid="receipts-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function ReceiptsTableError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load receipts</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}
