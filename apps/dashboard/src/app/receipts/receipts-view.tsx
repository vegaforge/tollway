"use client";

import {
  Ed25519Verifier,
  type ReceiptBody,
  type ReceiptVerification,
  type SettlementRef,
  type SignedReceipt,
  verifyReceipt,
} from "@tollway/core";
import { useEffect, useMemo, useState } from "react";

import { Panel } from "@/components/ui/panel";
import type { ReceiptRow } from "@/data/receipts";
import { useReceipts } from "@/data/use-receipts";

/**
 * Stellar SACs use 7 decimal places. When the observability hub starts
 * attaching per-asset metadata, the data layer can override this.
 */
const DEFAULT_ASSET_DECIMALS = 7;

const MODEL_LABEL: Record<ReceiptBody["model"], string> = {
  x402: "x402",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

function formatAmount(amount: string, asset: string): string {
  let units: bigint;
  try {
    units = BigInt(amount);
  } catch {
    return `${amount} ${asset}`;
  }
  const divisor = 10n ** BigInt(DEFAULT_ASSET_DECIMALS);
  const whole = units / divisor;
  const fraction = units % divisor;
  const fractionStr = fraction.toString().padStart(DEFAULT_ASSET_DECIMALS, "0").slice(0, 2);
  const code = asset.split(":")[0] ?? asset;
  return `${whole.toLocaleString("en-US")}.${fractionStr} ${code}`;
}

function truncate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function settlementSummary(ref: SettlementRef): string {
  if (ref.kind === "transaction") {
    return `tx ${truncate(ref.txHash, 8, 6)}`;
  }
  return `${ref.channelId} · seq ${ref.sequence}`;
}

export function ReceiptsView() {
  const state = useReceipts();

  const rows = state.status === "ready" ? state.rows : [];
  const trustedKeys = state.status === "ready" ? state.trustedKeys : null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => rows.find((row) => row.receipt.id === selectedId) ?? null,
    [rows, selectedId],
  );

  return (
    <Panel title="Receipts" description="Payer, payee, amount, model, and settlement reference">
      {state.status === "loading" ? <ReceiptsTableSkeleton /> : null}
      {state.status === "error" ? <ReceiptsTableError error={state.error} /> : null}
      {state.status === "ready" ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted">
            No receipts yet. Wire a paid route and the archive will populate.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            <ReceiptsTable
              rows={rows}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
            {selected && trustedKeys ? (
              <ReceiptDetail receipt={selected} trustedKeys={trustedKeys} />
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

function ReceiptsTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ReceiptRow[];
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
                  <span className="block font-mono text-xs text-muted">
                    {truncate(receipt.payer, 8, 6)}
                  </span>
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

function ReceiptDetail({
  receipt,
  trustedKeys,
}: {
  receipt: SignedReceipt;
  trustedKeys: Record<string, Uint8Array>;
}) {
  const [verification, setVerification] = useState<
    | { status: "verifying" }
    | { status: "verified"; result: ReceiptVerification }
    | { status: "error"; error: Error }
  >({ status: "verifying" });

  // Verifying on selection rather than on a button click matches the issue
  // acceptance criterion ("a detail view that verifies the signature") and
  // keeps the panel honest: a tampered or stale-keyed receipt surfaces an
  // invalid pill the moment the user opens it. Re-runs when the user picks
  // a different row.
  useEffect(() => {
    let cancelled = false;
    setVerification({ status: "verifying" });
    const verifier = new Ed25519Verifier(trustedKeys);
    verifyReceipt(receipt, verifier)
      .then((result) => {
        if (cancelled) return;
        setVerification({ status: "verified", result });
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
  }, [receipt, trustedKeys]);

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
      </dl>

      <footer className="mt-4 border-t border-border pt-3">
        <p className="text-xs uppercase tracking-wide text-muted">Signature</p>
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Detail label="Key id" value={receipt.signature.keyId} mono />
          <Detail label="Algorithm" value={receipt.signature.algorithm} />
        </dl>
        <p
          className="mt-2 break-all font-mono text-[11px] text-muted"
          data-testid="receipt-signature-value"
        >
          {receipt.signature.value}
        </p>
      </footer>
    </section>
  );
}

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
        <a
          // Channels view does not have per-channel routes yet; the channels
          // table renders each row with `data-testid="channel-row-<id>"`,
          // which doubles as a stable anchor target via the row's id-derived
          // hash. When the per-channel detail page lands, switch this to
          // /channels/{channelId} with no other change.
          href={`/channels#channel-row-${settlement.channelId}`}
          data-testid="receipt-channel-link"
          className="text-accent underline hover:no-underline"
        >
          {settlement.channelId}
        </a>
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
    | { status: "verified"; result: ReceiptVerification }
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
  if (verification.status === "error") {
    return (
      <span
        data-testid="receipt-verification-error"
        className="inline-flex items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-danger"
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
        className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-success"
      >
        Signature valid
      </span>
    );
  }
  return (
    <span
      data-testid="receipt-verification-invalid"
      className="inline-flex items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-danger"
      title={verification.result.reason}
    >
      Signature invalid
    </span>
  );
}

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
