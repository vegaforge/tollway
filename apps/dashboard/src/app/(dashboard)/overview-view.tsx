"use client";

import { settlementModels } from "@vegaforge/tollway-core";
import Link from "next/link";

import { AssetTotals } from "@/components/ui/asset-totals";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import {
  failureRateBasisPoints,
  type OverviewSnapshot,
  type OverviewSpend,
  remainingByAsset,
} from "@/data/overview";
import { useAnomalies } from "@/data/use-anomalies";
import { useOverview } from "@/data/use-overview";
import { assetCode, formatAmount, formatBasisPoints } from "@/lib/amount";
import { describeAnomaly, KIND_LABEL } from "@/lib/anomaly-copy";

const MODEL_LABEL: Record<(typeof settlementModels)[number], string> = {
  x402: "x402 per-request",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

/** How many anomaly events the Overview strip shows. */
const ANOMALY_STRIP_COUNT = 3;

export function OverviewView() {
  const state = useOverview();

  if (state.status === "loading") return <OverviewSkeleton />;
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
      >
        <p className="font-medium text-foreground">Could not load the overview</p>
        <p className="mt-1">{state.error.message}</p>
      </div>
    );
  }
  return <OverviewBody snapshot={state.snapshot} />;
}

function OverviewBody({ snapshot }: { snapshot: OverviewSnapshot }) {
  const { spend, channels, recentReceipts } = snapshot;
  const settledByAsset = Object.entries(spend.byAsset).map(([asset, amount]) => ({
    asset,
    amount,
  }));
  const openCount = channels.filter((channel) => channel.status === "open").length;
  const remaining = remainingByAsset(channels);
  const rate = failureRateBasisPoints(spend.byOutcome);
  const attempted = spend.byOutcome.settled + spend.byOutcome.failed;

  return (
    <>
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Settled spend"
          value={<AssetTotals entries={settledByAsset} />}
          hint="Settled payments only, per asset"
        />
        <StatCard
          label="Payments settled"
          value={spend.byOutcome.settled}
          hint="Failed and skipped payments are not counted"
        />
        <StatCard
          label="Open channels"
          value={
            <>
              {openCount}
              <span className="mt-1 block text-xs font-normal text-muted">
                Remaining: <AssetTotals entries={remaining} />
              </span>
            </>
          }
          hint="Status open"
        />
        <StatCard
          label="Failure rate"
          value={rate === null ? "No payments" : formatBasisPoints(rate)}
          hint={
            rate === null
              ? "Nothing was attempted this period"
              : `${spend.byOutcome.failed} of ${attempted} attempted payments failed`
          }
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ModelMix spend={spend} />

        <Panel title="Spend over time" description="Per-agent and per-service totals">
          <EmptyState
            title="Not wired yet"
            body="A time series of spend by agent and service will render here."
            source="@vegaforge/tollway-observability · timeseries()"
          />
        </Panel>

        <Panel
          title="Recent receipts"
          description="The newest signed receipts"
          action={
            <Link className="text-xs underline hover:text-foreground" href="/receipts">
              All receipts
            </Link>
          }
        >
          {recentReceipts.length === 0 ? (
            <p className="text-sm text-muted">No receipts yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {recentReceipts.map(({ receipt }) => (
                <li
                  key={receipt.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm"
                >
                  <span className="font-mono text-xs text-muted">{receipt.id}</span>
                  <span className="font-mono">{formatAmount(receipt.amount, receipt.asset)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <AnomaliesStrip />
      </div>
    </>
  );
}

/** The model mix per asset: each model's share of that asset's settled spend. */
function ModelMix({ spend }: { spend: OverviewSpend }) {
  const assets = Object.keys(spend.byAsset);

  return (
    <Panel title="Model mix" description="Each model's share of settled spend, per asset">
      {assets.length === 0 ? (
        <p className="text-sm text-muted">No settled spend this period.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {assets.map((asset) => {
            const total = BigInt(spend.byAsset[asset] ?? "0");
            return (
              <div key={asset}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  {assetCode(asset)}
                </p>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {settlementModels.map((model) => {
                    const entry = spend.byModelAsset.find(
                      (row) => row.model === model && row.asset === asset,
                    );
                    const amount = entry?.amount ?? "0";
                    // A model with no spend shows a zero share, not a gap.
                    const share = total === 0n ? 0n : (BigInt(amount) * 10_000n) / total;
                    return (
                      <li
                        key={model}
                        data-testid={`model-mix-${model}-${asset}`}
                        className="rounded-lg border border-border bg-surface-2 p-4"
                      >
                        <p className="text-xs font-medium">{MODEL_LABEL[model]}</p>
                        <p className="mt-2 text-xl font-semibold text-accent">
                          {formatBasisPoints(share)}
                        </p>
                        <p className="mt-1 font-mono text-xs text-muted">
                          {formatAmount(amount, asset)}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** The newest few feed events, read from the same hook as the anomalies page. */
function AnomaliesStrip() {
  const state = useAnomalies({ limit: ANOMALY_STRIP_COUNT });

  return (
    <Panel
      title="Anomalies"
      description="The newest policy stops, spikes, warnings, and drift"
      action={
        <Link className="text-xs underline hover:text-foreground" href="/anomalies">
          All anomalies
        </Link>
      }
    >
      {state.status === "loading" ? (
        <div className="space-y-2" data-testid="overview-anomalies-skeleton">
          {[0, 1].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-surface-2" />
          ))}
        </div>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Could not load anomalies: {state.error.message}
        </p>
      ) : null}
      {state.status === "ready" ? (
        state.page.events.length === 0 ? (
          <p className="text-sm text-muted">Nothing flagged.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {state.page.events.map((event) => (
              <li key={event.id} className="flex flex-col gap-1 py-3 text-sm">
                <span className="text-xs font-medium text-muted">{KIND_LABEL[event.kind]}</span>
                <span>{describeAnomaly(event)}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Panel>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-2" data-testid="overview-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}
