"use client";

import Link from "next/link";
import { useState } from "react";

import { Panel } from "@/components/ui/panel";
import { type Bucket, percentageBasisPoints, type ServiceCapUsage } from "@/data/agent-detail";
import { useAgentDetail } from "@/data/use-agent-detail";

const DECIMALS = 7n;
const ASSET_DIVISOR = 10n ** DECIMALS;
const BASIS_POINTS_PER_PERCENT = 100n;

type Range = "24h" | "7d" | "30d";

function formatAmount(amount: string, asset: string): string {
  const units = BigInt(amount);
  const whole = units / ASSET_DIVISOR;
  const fraction = units % ASSET_DIVISOR;
  const fractionText = fraction.toString().padStart(Number(DECIMALS), "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${fractionText} ${asset}`;
}

function formatPercent(basisPoints: bigint): string {
  const whole = basisPoints / BASIS_POINTS_PER_PERCENT;
  const fraction = basisPoints % BASIS_POINTS_PER_PERCENT;
  return `${whole}.${fraction.toString().padStart(2, "0")}%`;
}

function pointsForRange(
  points: { bucket: string; amount: string }[],
  bucket: Bucket,
  range: Range,
) {
  const count =
    bucket === "hour"
      ? range === "24h"
        ? 24
        : range === "7d"
          ? 168
          : 720
      : range === "24h"
        ? 1
        : range === "7d"
          ? 7
          : 30;
  return points.slice(-count);
}

function UsageLine({
  testId,
  label,
  budgetLabel,
  budget,
  usedByAsset,
}: {
  testId: string;
  label: string;
  budgetLabel: string;
  budget: string | null;
  usedByAsset: { asset: string; amount: string }[];
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-border p-4">
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted">
        {budgetLabel}: {budget ?? "none"}
      </p>
      <ul className="mt-2 space-y-1 text-xs font-mono">
        {usedByAsset.length === 0 ? (
          <li>0.00%</li>
        ) : (
          usedByAsset.map((entry) => {
            const used = BigInt(entry.amount);
            const percent = budget === null ? null : percentageBasisPoints(used, BigInt(budget));
            return (
              <li key={entry.asset}>
                {entry.asset}: {formatAmount(entry.amount, entry.asset)} ·{" "}
                {percent === null ? "no budget" : formatPercent(percent)}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export function AgentDetailView({ agentId }: { agentId: string }) {
  const state = useAgentDetail(agentId);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [range, setRange] = useState<Range>("24h");

  if (state.status === "loading") {
    return (
      <div className="space-y-2" data-testid="agent-detail-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
      >
        <p className="font-medium text-foreground">Could not load agent detail</p>
        <p className="mt-1">{state.error.message}</p>
      </div>
    );
  }

  const { detail } = state;
  const selectedSeries = detail.series.find((entry) => entry.bucket === bucket) ?? detail.series[0];
  const assets = selectedSeries?.assets ?? [];

  return (
    <div className="space-y-6">
      <Panel title="Agent" description="Identity and payer addresses">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Label</dt>
            <dd className="mt-1 font-medium">{detail.label}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Agent id</dt>
            <dd className="mt-1 font-mono text-sm">{detail.id}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Payer addresses</dt>
            <dd className="mt-1">
              <ul className="space-y-1 font-mono text-sm">
                {detail.payerAddresses.map((address) => (
                  <li key={address}>{address}</li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Spend over time"
        description="Settled payments only. One series per asset, grouped by UTC bucket."
        action={
          <div className="flex gap-2">
            <div>
              <label className="mr-1 text-xs text-muted" htmlFor="agent-bucket">
                Bucket
              </label>
              <select
                id="agent-bucket"
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs"
                value={bucket}
                onChange={(event) => setBucket(event.target.value as Bucket)}
              >
                <option value="day">day</option>
                <option value="hour">hour</option>
              </select>
            </div>
            <div>
              <label className="mr-1 text-xs text-muted" htmlFor="agent-range">
                Range
              </label>
              <select
                id="agent-range"
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs"
                value={range}
                onChange={(event) => setRange(event.target.value as Range)}
              >
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
            </div>
          </div>
        }
      >
        {assets.length === 0 ? (
          <p className="text-sm text-muted">No settled spend in this range.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {assets.map((series) => (
              <div
                key={series.asset}
                data-testid={`agent-series-${series.asset}`}
                className="rounded-lg border border-border p-4"
              >
                <p className="font-medium">{series.asset}</p>
                <ul className="mt-2 space-y-1 text-xs font-mono">
                  {pointsForRange(series.points, bucket, range).map((point) => (
                    <li key={point.bucket} className="flex justify-between gap-2">
                      <span className="text-muted">{point.bucket}</span>
                      <span>{formatAmount(point.amount, series.asset)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Model mix" description="Settled spend per model and asset">
          {detail.byModel.length === 0 ? (
            <p className="text-sm text-muted">No settled spend by model.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.byModel.map((entry) => (
                <li key={`${entry.key}-${entry.asset}`} className="flex justify-between gap-3">
                  <span>{entry.key}</span>
                  <span className="text-xs text-muted">{entry.asset}</span>
                  <span className="font-mono">{formatAmount(entry.amount, entry.asset)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Services paid" description="Settled spend per payee and asset">
          {detail.byPayee.length === 0 ? (
            <p className="text-sm text-muted">No settled spend by service.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.byPayee.map((entry) => (
                <li key={`${entry.key}-${entry.asset}`} className="flex justify-between gap-3">
                  <span>{entry.key}</span>
                  <span className="text-xs text-muted">{entry.asset}</span>
                  <span className="font-mono">{formatAmount(entry.amount, entry.asset)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Budget usage"
        description="The daily window is a UTC day, matching the policy engine"
      >
        {detail.policy === null ? (
          <p className="text-sm text-muted">No policy governs this agent.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted">
              Budget unit ambiguity: the policy declares a single number, so each asset is compared
              against it separately until budgets are keyed by asset in #191.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <UsageLine
                testId="budget-usage-daily"
                label="Daily budget (UTC day)"
                budgetLabel="Budget (base units, unit ambiguous)"
                budget={detail.policy.daily.budget}
                usedByAsset={detail.policy.daily.usedByAsset}
              />
              <UsageLine
                testId="budget-usage-total"
                label="Total budget"
                budgetLabel="Budget (base units, unit ambiguous)"
                budget={detail.policy.total.budget}
                usedByAsset={detail.policy.total.usedByAsset}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Per-service caps</h3>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                {detail.policy.perService.length === 0 ? (
                  <p className="text-sm text-muted">No per-service caps in this policy.</p>
                ) : (
                  detail.policy.perService.map((cap: ServiceCapUsage) => (
                    <UsageLine
                      key={cap.payee}
                      testId={`service-cap-${cap.payee}`}
                      label={cap.payee}
                      budgetLabel="Cap (base units, unit ambiguous)"
                      budget={cap.cap}
                      usedByAsset={cap.usedByAsset}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Recent policy stops" description="Rule that fired and why">
        {detail.recentStops.length === 0 ? (
          <p className="text-sm text-muted">No recent policy stops.</p>
        ) : (
          <ul className="space-y-3">
            {detail.recentStops.map((stop, index) => (
              <li
                key={`${stop.at}-${stop.rule}`}
                data-testid={`policy-stop-${index}`}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border p-4 text-sm"
              >
                <span>
                  <span className="font-medium">{stop.rule}</span>
                  <span className="ml-2 text-muted">{stop.detail}</span>
                  <span className="ml-2 font-mono text-xs text-muted">{stop.at}</span>
                </span>
                <Link
                  className="text-xs underline hover:text-foreground"
                  href={`/anomalies?agent=${encodeURIComponent(detail.id)}`}
                >
                  View in anomalies
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
