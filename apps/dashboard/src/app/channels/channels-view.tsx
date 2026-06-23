"use client";

import type { ChannelStatus } from "@tollway/channels";
import { useMemo } from "react";

import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import type { OpenChannelRow } from "@/data/open-channels";
import { useOpenChannels } from "@/data/use-open-channels";

/**
 * Default precision used to render integer-string amounts. Stellar SACs (the
 * settlement target of @tollway/core) use 7 decimal places. When the
 * observability hub starts attaching per-asset metadata to rows, the data
 * layer can override this.
 */
const DEFAULT_ASSET_DECIMALS = 7;

/**
 * Default drawdown fraction at which an open channel is flagged as nearing
 * close. Mirrors the ClosePolicy.drawdownThreshold heuristic in
 * @tollway/channels: when committed / deposit reaches this fraction the
 * channel manager's shouldClose returns true. Overridable via prop so the
 * view stays decoupled from the policy engine.
 */
const DEFAULT_NEARING_CLOSE_THRESHOLD = 0.8;

function drawdownRatio(row: OpenChannelRow): number {
  const deposit = BigInt(row.deposit);
  if (deposit === 0n) return 0;
  const committed = BigInt(row.committed);
  // Keep four digits of precision via bigint arithmetic, then divide once.
  return Number((committed * 10_000n) / deposit) / 10_000;
}

function isNearingClose(row: OpenChannelRow, threshold: number): boolean {
  return row.status === "open" && drawdownRatio(row) >= threshold;
}

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
  return `${whole.toLocaleString("en-US")}.${fractionStr} ${asset}`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function sumAmounts(rows: OpenChannelRow[], pick: (row: OpenChannelRow) => string): bigint {
  return rows.reduce((acc, row) => acc + BigInt(pick(row)), 0n);
}

function headlineAsset(rows: OpenChannelRow[]): string {
  return rows[0]?.asset ?? "USDC";
}

export function ChannelsView({
  nearingCloseThreshold = DEFAULT_NEARING_CLOSE_THRESHOLD,
}: {
  nearingCloseThreshold?: number;
}) {
  const state = useOpenChannels();

  const rows = state.status === "ready" ? state.rows : [];

  // Sort by drawdown descending so the rows nearest to close surface first.
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => drawdownRatio(b) - drawdownRatio(a)),
    [rows],
  );

  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { deposit: "0", committed: "0", asset: "USDC", openCount: 0 };
    }
    return {
      deposit: sumAmounts(rows, (r) => r.deposit).toString(),
      committed: sumAmounts(rows, (r) => r.committed).toString(),
      asset: headlineAsset(rows),
      openCount: rows.filter((r) => r.status === "open").length,
    };
  }, [rows]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open channels"
          value={state.status === "ready" ? totals.openCount : "-"}
          hint="Status open, excluding closing and closed"
        />
        <StatCard
          label="Total deposited"
          value={state.status === "ready" ? formatAmount(totals.deposit, totals.asset) : "-"}
          hint="Cumulative across all tracked channels"
        />
        <StatCard
          label="Total committed"
          value={state.status === "ready" ? formatAmount(totals.committed, totals.asset) : "-"}
          hint="Off-chain commitments awaiting close"
        />
      </div>

      <Panel
        title="Open channels"
        description="Sorted by drawdown. Nearing-close rows are highlighted."
        className="mt-6"
      >
        {state.status === "loading" ? <ChannelsTableSkeleton /> : null}
        {state.status === "error" ? <ChannelsTableError error={state.error} /> : null}
        {state.status === "ready" ? (
          rows.length === 0 ? (
            <p className="text-sm text-muted">No open channels. Open one and reload.</p>
          ) : (
            <ChannelsTable rows={sortedRows} nearingCloseThreshold={nearingCloseThreshold} />
          )
        ) : null}
      </Panel>
    </>
  );
}

function ChannelsTable({
  rows,
  nearingCloseThreshold,
}: {
  rows: OpenChannelRow[];
  nearingCloseThreshold: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Counterparty
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Committed / Deposit
            </th>
            <th scope="col" className="px-3 py-2 font-medium text-right">
              Sequence
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ratio = drawdownRatio(row);
            const nearing = isNearingClose(row, nearingCloseThreshold);
            return (
              <tr
                key={row.id}
                data-testid={`channel-row-${row.id}`}
                data-nearing-close={nearing ? "true" : undefined}
                className={`border-b border-border last:border-b-0 ${
                  nearing ? "border-l-2 border-l-accent bg-accent/5" : ""
                }`}
              >
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{row.counterparty}</span>
                    {nearing ? (
                      <span
                        data-testid={`nearing-close-${row.id}`}
                        className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                      >
                        Nearing close
                      </span>
                    ) : null}
                  </div>
                  <span className="font-mono text-xs text-muted">{row.id}</span>
                </td>
                <td className="px-3 py-3">
                  <DrawdownCell row={row} ratio={ratio} />
                </td>
                <td className="px-3 py-3 text-right font-mono">{row.sequence}</td>
                <td className="px-3 py-3">
                  <StatusPill status={row.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DrawdownCell({ row, ratio }: { row: OpenChannelRow; ratio: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="font-mono">{formatAmount(row.committed, row.asset)}</span>
        <span className="text-xs text-muted">/ {formatAmount(row.deposit, row.asset)}</span>
        <span className="ml-auto text-xs text-muted">{formatPercent(ratio)}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
        />
      </div>
    </div>
  );
}

const STATUS_PILL_CLASSES: Record<ChannelStatus, string> = {
  open: "bg-success/15 text-success",
  closing: "bg-warning/15 text-warning",
  closed: "bg-surface-2 text-muted",
  recovering: "bg-danger/15 text-danger",
  recovered: "bg-success/15 text-success",
};

function StatusPill({ status }: { status: ChannelStatus }) {
  return (
    <span
      data-testid={`status-pill-${status}`}
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL_CLASSES[status]}`}
    >
      {status}
    </span>
  );
}

function ChannelsTableSkeleton() {
  return (
    <div className="space-y-2" data-testid="channels-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function ChannelsTableError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load open channels</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}
