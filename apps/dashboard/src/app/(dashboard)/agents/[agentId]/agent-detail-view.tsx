"use client";

import Link from "next/link";
import { useState } from "react";

import { Panel } from "@/components/ui/panel";
import {
  type AgentPolicyUsage,
  type AmountByKey,
  type AssetSeries,
  type Bucket,
  buckets,
  type LimitUsage,
  percentageBasisPoints,
  type Range,
  ranges,
} from "@/data/agent-detail";
import { useAgentDetail } from "@/data/use-agent-detail";
import { formatAssetAmount, formatBasisPoints } from "@/lib/amount";

const FULL = 10_000n;

function bucketLabel(start: string, bucket: Bucket): string {
  // Bucket starts are UTC; the label says so rather than shifting to local time.
  return bucket === "hour"
    ? `${start.slice(0, 10)} ${start.slice(11, 16)} UTC`
    : start.slice(0, 10);
}

function SeriesTable({ series, bucket }: { series: AssetSeries; bucket: Bucket }) {
  return (
    <div data-testid={`agent-series-${series.asset}`} className="rounded-lg border border-border">
      <h3 className="border-b border-border px-4 py-2 font-medium">{series.asset}</h3>
      <section
        className="max-h-72 overflow-auto"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard to scroll a long hourly series (WCAG 2.1.1, axe scrollable-region-focusable).
        tabIndex={0}
        aria-label={`${series.asset} spend per ${bucket}`}
      >
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface text-left text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                {bucket === "hour" ? "Hour (UTC)" : "Day (UTC)"}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Settled
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {series.points.map((point) => (
              <tr key={point.start} className="border-t border-border">
                <td className="px-4 py-1.5 text-muted">{bucketLabel(point.start, bucket)}</td>
                <td className="px-4 py-1.5 text-right">
                  {formatAssetAmount(point.amount, series.asset)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AmountTable({ rows, keyLabel }: { rows: AmountByKey[]; keyLabel: string }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th scope="col" className="pb-2 font-medium">
            {keyLabel}
          </th>
          <th scope="col" className="pb-2 font-medium">
            Asset
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            Settled
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.key}-${row.asset}`} className="border-t border-border">
            <td className="py-2 font-mono text-xs">{row.key}</td>
            <td className="py-2 text-xs text-muted">{row.asset}</td>
            <td className="py-2 text-right font-mono">
              {formatAssetAmount(row.amount, row.asset)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageRow({ asset, used, limit }: { asset: string; used: string; limit: string }) {
  const basisPoints = percentageBasisPoints(BigInt(used), BigInt(limit));
  const over = basisPoints === null ? BigInt(used) > 0n : basisPoints > FULL;
  const width = basisPoints === null ? (over ? FULL : 0n) : basisPoints > FULL ? FULL : basisPoints;
  return (
    <li data-testid={`usage-${asset}`} className="space-y-1">
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <span>
          <span className="font-medium">{asset}</span>{" "}
          <span className="font-mono">
            {formatAssetAmount(used, asset)} of {formatAssetAmount(limit, asset)}
          </span>
        </span>
        <span className="font-mono">
          {basisPoints === null ? "limit is 0" : formatBasisPoints(basisPoints)}
          {over ? <span className="ml-2 font-sans font-semibold">Over limit</span> : null}
        </span>
      </div>
      {/* The bar repeats the percentage above for sighted users only. */}
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${over ? "bg-danger" : "bg-primary"}`}
          style={{ width: `${width / 100n}%` }}
        />
      </div>
    </li>
  );
}

function LimitCard({
  testId,
  title,
  window,
  usage,
}: {
  testId: string;
  title: string;
  window: string;
  usage: LimitUsage;
}) {
  const { limit } = usage;
  return (
    <div data-testid={testId} className="rounded-lg border border-border p-4">
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{window}</p>
      {limit === null ? (
        <p className="mt-3 text-sm text-muted">Not set in this policy.</p>
      ) : (
        <>
          <p className="mt-2 text-xs">
            Limit: <span className="font-mono">{limit}</span> base units
          </p>
          {usage.usedByAsset.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No settled spend in this window (0.00%).</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {usage.usedByAsset.map((entry) => (
                <UsageRow key={entry.asset} asset={entry.asset} used={entry.amount} limit={limit} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function BudgetUsage({ policy }: { policy: AgentPolicyUsage | null }) {
  if (policy === null) {
    return (
      <p data-testid="no-policy" className="text-sm">
        No policy governs this agent, so nothing limits its spend: there is no daily budget, total
        budget or per-service cap to measure against.
      </p>
    );
  }
  const since = policy.effectiveFrom.slice(0, 10);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        The policy states each limit as one number with no asset. The engine compares every
        asset&apos;s spend against that same number separately, so each asset is shown against it in
        its own units. Budgets keyed by asset arrive with #191.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <LimitCard
          testId="budget-usage-daily"
          title="Daily budget"
          window={`UTC day ${policy.utcDay}, 00:00 to 24:00 UTC`}
          usage={policy.daily}
        />
        <LimitCard
          testId="budget-usage-total"
          title="Total budget"
          window={`Since the policy took effect on ${since}`}
          usage={policy.total}
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold">Per-service caps</h3>
        {policy.perService.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No per-service caps in this policy.</p>
        ) : (
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            {policy.perService.map((cap) => (
              <LimitCard
                key={cap.payee}
                testId={`service-cap-${cap.payee}`}
                title={cap.payee}
                window={`Since the policy took effect on ${since}`}
                usage={cap}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Select<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <label className="mr-1 text-xs text-muted" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs"
        value={value}
        onChange={(event) => {
          const next = options.find((option) => option === event.target.value);
          if (next !== undefined) onChange(next);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AgentDetailView({ agentId }: { agentId: string }) {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [range, setRange] = useState<Range>("7d");
  const state = useAgentDetail(agentId, { bucket, range });

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
        <Link className="mt-3 inline-block text-xs underline" href="/agents">
          Back to agents
        </Link>
      </div>
    );
  }

  const { detail } = state;
  const anomaliesHref = `/anomalies?agent=${encodeURIComponent(detail.id)}`;

  return (
    <div className="space-y-6">
      <Link className="text-xs text-muted underline-offset-2 hover:underline" href="/agents">
        Back to agents
      </Link>

      <Panel title="Agent" description="Identity and the payer addresses it pays from">
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
        description={`Settled payments only, one series per asset, ${detail.from.slice(0, 16)} to ${detail.to.slice(0, 16)} UTC`}
        action={
          <div className="flex gap-3">
            <Select
              id="agent-bucket"
              label="Bucket"
              value={bucket}
              options={buckets}
              onChange={setBucket}
            />
            <Select
              id="agent-range"
              label="Range"
              value={range}
              options={ranges}
              onChange={setRange}
            />
          </div>
        }
      >
        {detail.series.length === 0 ? (
          <p className="text-sm text-muted">No settled spend in this range.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.series.map((series) => (
              <SeriesTable key={series.asset} series={series} bucket={detail.query.bucket} />
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Model mix" description="Settled spend in the range, per model and asset">
          {detail.byModel.length === 0 ? (
            <p className="text-sm text-muted">No settled spend in this range.</p>
          ) : (
            <AmountTable rows={detail.byModel} keyLabel="Model" />
          )}
        </Panel>
        <Panel title="Services paid" description="Settled spend in the range, per payee and asset">
          {detail.byPayee.length === 0 ? (
            <p className="text-sm text-muted">No settled spend in this range.</p>
          ) : (
            <AmountTable rows={detail.byPayee} keyLabel="Payee" />
          )}
        </Panel>
      </div>

      <Panel
        title="Budget usage"
        description="Limits from the governing policy against settled spend, in the engine's windows"
      >
        <BudgetUsage policy={detail.policy} />
      </Panel>

      <Panel
        title="Recent policy stops"
        description="Payments the policy refused, with the rule that fired"
        action={
          <Link className="text-xs underline hover:text-foreground" href={anomaliesHref}>
            View in anomalies
          </Link>
        }
      >
        {detail.recentStops.length === 0 ? (
          <p className="text-sm text-muted">No recent policy stops.</p>
        ) : (
          <ul className="space-y-3">
            {detail.recentStops.map((stop) => (
              <li
                key={`${stop.at}-${stop.ruleId}`}
                data-testid={`policy-stop-${stop.ruleId}`}
                className="rounded-lg border border-border p-4 text-sm"
              >
                <p>
                  <span className="font-medium">{stop.ruleId}</span>
                  <span className="ml-2 font-mono text-xs text-muted">
                    {stop.at.slice(0, 16).replace("T", " ")} UTC
                  </span>
                </p>
                <p className="mt-1 text-muted">{stop.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
