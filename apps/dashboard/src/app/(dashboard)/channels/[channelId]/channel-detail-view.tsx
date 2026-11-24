"use client";

import type { ChannelStatus } from "@vegaforge/tollway-channels";
import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import {
  type ChannelDetail,
  type ChannelReconciliation,
  CLOSE_THRESHOLD_BASIS_POINTS,
  type CommitmentStep,
  commitmentSteps,
  drawdownBasisPoints,
  scaleBasisPoints,
} from "@/data/channel-detail";
import { useChannelDetail } from "@/data/use-channel-detail";
import { formatAmount, formatBasisPoints } from "@/lib/amount";

const PAGE_SIZE = 25;

const CHART = { width: 640, height: 240, pad: 36 } as const;

const STATUS_PILL_CLASSES: Record<ChannelStatus, string> = {
  open: "bg-success/15 text-foreground",
  closing: "bg-warning/15 text-foreground",
  closed: "bg-surface-2 text-muted",
  recovering: "bg-danger/15 text-foreground",
  recovered: "bg-success/15 text-foreground",
  "settlement-mismatched": "bg-danger/15 text-foreground",
};

export function ChannelDetailView({ channelId }: { channelId: string }) {
  const state = useChannelDetail(channelId);

  if (state.status === "loading") return <DetailSkeleton />;
  if (state.status === "error") return <DetailError error={state.error} />;
  if (state.status === "not-found") return <DetailNotFound channelId={channelId} />;
  return <DetailBody detail={state.detail} />;
}

function DetailBody({ detail }: { detail: ChannelDetail }) {
  const { channel, commitments, reconciliation, receipts } = detail;
  const steps = useMemo(() => commitmentSteps(commitments), [commitments]);
  const drawdown = drawdownBasisPoints(channel.committed, channel.deposit);
  const remaining = (BigInt(channel.deposit) - BigInt(channel.committed)).toString();

  return (
    <section data-testid="channel-detail" aria-label="Channel" className="flex flex-col gap-6">
      <header className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono text-base font-semibold">{channel.id}</h2>
          <span
            data-testid={`status-pill-${channel.status}`}
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL_CLASSES[channel.status]}`}
          >
            {channel.status}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <HeaderItem label="Counterparty" value={channel.counterparty} mono />
          <HeaderItem label="Asset" value={channel.asset} />
          <HeaderItem label="Network" value={channel.network} />
          <HeaderItem label="Open transaction" value={channel.openTxHash} mono />
          <HeaderItem
            label="Settlement transaction"
            value={channel.settlementTxHash ?? "Not settled"}
            mono={channel.settlementTxHash !== undefined}
          />
          <HeaderItem label="Opened" value={channel.openedAt} mono />
          <HeaderItem
            label="Last commitment"
            value={channel.lastCommitAt ?? "No commitments yet"}
            mono={channel.lastCommitAt !== undefined}
          />
        </dl>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Deposit"
          value={formatAmount(channel.deposit, channel.asset)}
          hint="Locked when the channel opened"
        />
        <StatCard
          label="Committed"
          value={formatAmount(channel.committed, channel.asset)}
          hint="Latest cumulative commitment"
        />
        <StatCard
          label="Remaining"
          value={formatAmount(remaining, channel.asset)}
          hint="Deposit minus committed"
        />
        <StatCard
          label="Drawdown"
          value={drawdown === null ? "No deposit" : formatBasisPoints(drawdown)}
          hint="Committed as a share of the deposit"
        />
      </div>

      <Panel
        title="Cumulative commitments"
        description="Cumulative amount by sequence, against the deposit and the close threshold"
      >
        {steps.length === 0 ? (
          <p className="text-sm text-muted">
            No commitments yet. The chart appears after the first one.
          </p>
        ) : (
          <CumulativeChart steps={steps} channel={channel} />
        )}
      </Panel>

      <Panel
        title="Commitment stream"
        description="Every commitment in sequence order. A sequence gap or a falling total is flagged."
      >
        {steps.length === 0 ? (
          <p className="text-sm text-muted">This channel has no commitments.</p>
        ) : (
          <CommitmentTable steps={steps} asset={channel.asset} />
        )}
      </Panel>

      <Panel
        title="Reconciliation"
        description="The latest check of the stream against the settlement"
      >
        <ReconciliationStatus reconciliation={reconciliation} />
      </Panel>

      <Panel
        title="Receipts"
        description="Receipts that settle through this channel, newest first"
      >
        {receipts.length === 0 ? (
          <p className="text-sm text-muted">No receipts settle through this channel yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {receipts.map(({ receipt }) => (
              <li
                key={receipt.id}
                data-testid={`channel-receipt-${receipt.id}`}
                className="flex flex-wrap items-baseline justify-between gap-3 py-3 text-sm"
              >
                <span className="font-mono text-xs">{receipt.id}</span>
                <span className="font-mono">{formatAmount(receipt.amount, receipt.asset)}</span>
                <span className="font-mono text-xs text-muted">
                  {receipt.settlement.kind === "channel-commitment"
                    ? `seq ${receipt.settlement.sequence}`
                    : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

function HeaderItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * The cumulative line, drawn as one inline SVG polyline so a few hundred points
 * cost one element. The deposit and the close threshold are reference lines.
 * The scale tops out at the larger of the deposit and the highest cumulative
 * amount, so an over-deposit commitment is drawn rather than clipped. The
 * caption and the commitment table give the same numbers as text.
 */
function CumulativeChart({
  steps,
  channel,
}: {
  steps: CommitmentStep[];
  channel: ChannelDetail["channel"];
}) {
  const depositUnits = BigInt(channel.deposit);
  const top = steps.reduce((max, step) => {
    const cumulative = BigInt(step.cumulativeAmount);
    return cumulative > max ? cumulative : max;
  }, depositUnits);

  const innerWidth = CHART.width - CHART.pad * 2;
  const innerHeight = CHART.height - CHART.pad * 2;
  const xAt = (index: number) =>
    CHART.pad + (steps.length <= 1 ? 0 : (index / (steps.length - 1)) * innerWidth);
  const yAt = (amount: bigint) =>
    CHART.pad + innerHeight - (scaleBasisPoints(amount, top) / 10_000) * innerHeight;

  const points = steps.map((step, index) => {
    const x = xAt(index).toFixed(1);
    const y = yAt(BigInt(step.cumulativeAmount)).toFixed(1);
    return `${x},${y}`;
  });
  const depositY = yAt(depositUnits);
  const thresholdY = yAt((depositUnits * CLOSE_THRESHOLD_BASIS_POINTS) / 10_000n);

  const last = steps.at(-1);
  const committed = formatAmount(last?.cumulativeAmount ?? "0", channel.asset);
  const deposit = formatAmount(channel.deposit, channel.asset);
  const summary = `${committed} of ${deposit} committed across ${steps.length} commitments.`;

  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-labelledby="cumulative-chart-title"
        aria-describedby="cumulative-chart-desc"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        className="h-auto w-full"
      >
        <title id="cumulative-chart-title">Cumulative commitments against the deposit</title>
        <desc id="cumulative-chart-desc">{summary}</desc>
        <line
          x1={CHART.pad}
          x2={CHART.width - CHART.pad}
          y1={depositY}
          y2={depositY}
          stroke="currentColor"
          strokeWidth={1}
          className="text-foreground"
        />
        <line
          x1={CHART.pad}
          x2={CHART.width - CHART.pad}
          y1={thresholdY}
          y2={thresholdY}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 4"
          className="text-warning"
        />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          className="text-accent"
        />
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{summary}</span>
        <span>Solid line: deposit. Dashed line: close threshold at 80% of the deposit.</span>
      </figcaption>
    </figure>
  );
}

function CommitmentTable({ steps, asset }: { steps: CommitmentStep[]; asset: string }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(steps.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = steps.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Sequence
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Cumulative
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Change
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Flag
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((step) => {
              const flagged = step.issues.length > 0;
              return (
                <tr
                  key={step.sequence}
                  data-testid={`commitment-row-${step.sequence}`}
                  data-flagged={flagged ? "true" : undefined}
                  className={`border-b border-border last:border-b-0 ${flagged ? "bg-danger/10" : ""}`}
                >
                  <td className="px-3 py-2 text-right font-mono">{step.sequence}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatAmount(step.cumulativeAmount, asset)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-muted">
                    {step.deltaAmount.startsWith("-")
                      ? `-${formatAmount(step.deltaAmount.slice(1), asset)}`
                      : formatAmount(step.deltaAmount, asset)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {step.issues.map((issue) => (
                      <span
                        key={issue}
                        className="mr-2 rounded-full bg-surface-2 px-2 py-0.5 font-medium uppercase tracking-wide text-foreground"
                      >
                        {issue === "sequence-gap" ? "Sequence gap" : "Falling total"}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <nav aria-label="Commitment pages" className="flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => setPage(current - 1)}
          disabled={current === 0}
          className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
        >
          Previous
        </button>
        <span aria-live="polite" className="text-muted">
          Page {current + 1} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => setPage(current + 1)}
          disabled={current >= pageCount - 1}
          className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
        >
          Next
        </button>
      </nav>
    </div>
  );
}

function ReconciliationStatus({ reconciliation }: { reconciliation: ChannelReconciliation }) {
  if (reconciliation.status === "never-reconciled") {
    return (
      <p data-testid="reconcile-never-reconciled" className="text-sm text-muted">
        Not reconciled yet. A result appears here after the channel closes and the check runs.
      </p>
    );
  }
  if (reconciliation.status === "ok") {
    return (
      <p data-testid="reconcile-ok" className="text-sm">
        Reconciled ok at {reconciliation.checkedAt}. The commitment stream matches the settlement.
      </p>
    );
  }
  const count = reconciliation.drift.length;
  return (
    <div data-testid="reconcile-drift" className="flex flex-col gap-3 text-sm">
      <p>
        Reconciliation found {count} {count === 1 ? "drift" : "drifts"} at{" "}
        {reconciliation.checkedAt}.
      </p>
      <ul className="flex flex-col gap-2">
        {reconciliation.drift.map((item) => (
          <li key={`${item.kind}:${item.detail}`} className="flex flex-col gap-1">
            <span className="w-fit rounded-full bg-danger/15 px-2 py-0.5 font-mono text-xs">
              {item.kind}
            </span>
            <span className="text-muted">{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-2" data-testid="channel-detail-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function DetailError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load this channel</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}

function DetailNotFound({ channelId }: { channelId: string }) {
  return (
    <div data-testid="channel-not-found" className="flex flex-col gap-4">
      <EmptyState
        title="Channel not found"
        body={`No tracked channel has the id ${channelId}. Check the id, or go back to the channels list.`}
        source="@vegaforge/tollway-channels · ChannelManager.get"
      />
      <Link className="text-sm underline" href="/channels">
        Back to channels
      </Link>
    </div>
  );
}
