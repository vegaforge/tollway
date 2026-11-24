"use client";

import { useMemo, useState } from "react";

import { AssetTotals } from "@/components/ui/asset-totals";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import type { ServiceModelStats, ServiceRevenueRow } from "@/data/service-revenue";
import { useServiceRevenue } from "@/data/use-service-revenue";
import { formatAmount, formatBasisPoints, shareBasisPoints, sumByAsset } from "@/lib/amount";

type SortKey = "revenue" | "count";
type SortDirection = "asc" | "desc";
type Sort = { key: SortKey; direction: SortDirection };

const MODEL_LABEL: Record<ServiceModelStats["model"], string> = {
  x402: "x402 per-request",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

/** Revenue compares as BigInt, so two amounts above 2^53 still order exactly. */
function compareRows(a: ServiceRevenueRow, b: ServiceRevenueRow, sort: Sort): number {
  const left = sort.key === "revenue" ? BigInt(a.revenue) : BigInt(a.count);
  const right = sort.key === "revenue" ? BigInt(b.revenue) : BigInt(b.count);
  if (left === right) return a.id.localeCompare(b.id);
  const ascending = left < right ? -1 : 1;
  return sort.direction === "asc" ? ascending : -ascending;
}

export function ServicesView() {
  const state = useServiceRevenue();
  const [sort, setSort] = useState<Sort>({ key: "revenue", direction: "desc" });

  const rows = state.status === "ready" ? state.rows : [];
  const sortedRows = useMemo(() => [...rows].sort((a, b) => compareRows(a, b, sort)), [rows, sort]);
  const revenueTotals = useMemo(() => sumByAsset(rows, (row) => row.revenue), [rows]);
  const settledCount = rows.reduce((sum, row) => sum + row.count, 0);
  const serviceCount = new Set(rows.map((row) => row.payee)).size;

  // Clicking the active column flips it; clicking another starts it descending.
  const toggle = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total revenue"
          value={state.status === "ready" ? <AssetTotals entries={revenueTotals} /> : "-"}
          hint="Settled, per asset, across services"
        />
        <StatCard
          label="Settled payments"
          value={state.status === "ready" ? settledCount : "-"}
          hint="Failed and skipped payments are not counted"
        />
        <StatCard
          label="Services"
          value={state.status === "ready" ? serviceCount : "-"}
          hint="Payees with settled revenue"
        />
      </div>

      <Panel
        title="Revenue per service"
        description="One row per payee and asset, with the settlement model mix and latency per model"
        className="mt-6"
      >
        {state.status === "loading" ? <ServicesTableSkeleton /> : null}
        {state.status === "error" ? <ServicesTableError error={state.error} /> : null}
        {state.status === "ready" ? (
          rows.length === 0 ? (
            <EmptyState
              title="No service has settled a payment yet"
              body="Revenue, model mix and latency appear here once a paid route settles."
              source="@vegaforge/tollway-observability · summarize({ payee })"
            />
          ) : (
            <ServicesTable rows={sortedRows} sort={sort} onSort={toggle} />
          )
        ) : null}
      </Panel>
    </>
  );
}

function ServicesTable({
  rows,
  sort,
  onSort,
}: {
  rows: ServiceRevenueRow[];
  sort: Sort;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Settled revenue, payment count, settlement model mix and average latency per model, for
          each service and asset
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Service
            </th>
            <SortableHeader label="Revenue" column="revenue" sort={sort} onSort={onSort} />
            <SortableHeader label="Payments" column="count" sort={sort} onSort={onSort} />
            <th scope="col" className="px-3 py-2 font-medium">
              Model mix
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Avg latency per model
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-3 py-3 text-left font-normal">
                <span className="font-medium">{row.label}</span>
                {row.label !== row.payee ? (
                  <span className="mt-0.5 block break-all font-mono text-xs text-muted">
                    {row.payee}
                  </span>
                ) : null}
              </th>
              <td className="px-3 py-3 font-mono">{formatAmount(row.revenue, row.asset)}</td>
              <td className="px-3 py-3 font-mono">{row.count}</td>
              <td className="px-3 py-3">
                <ModelMix row={row} />
              </td>
              <td className="px-3 py-3">
                <LatencyPerModel row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  return (
    <th
      scope="col"
      className="px-3 py-2 font-medium"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 rounded font-medium uppercase tracking-wide text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {label}
        <span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

/** Each model's share of the row's settled payments, as chips. Models with none are left out. */
function ModelMix({ row }: { row: ServiceRevenueRow }) {
  const total = BigInt(row.count);
  const used = row.models.filter((model) => model.count > 0);
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={`model-mix-${row.id}`}>
      {used.map((model) => (
        <li
          key={model.model}
          className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
        >
          {MODEL_LABEL[model.model]}{" "}
          <span className="font-mono">
            {formatBasisPoints(shareBasisPoints(BigInt(model.count), total))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LatencyPerModel({ row }: { row: ServiceRevenueRow }) {
  const measured = row.models.filter((model) => model.avgLatencyMs !== null);
  return (
    <ul className="space-y-0.5 text-xs" data-testid={`latency-${row.id}`}>
      {measured.map((model) => (
        <li key={model.model}>
          {MODEL_LABEL[model.model]}: <span className="font-mono">{model.avgLatencyMs} ms</span>
        </li>
      ))}
    </ul>
  );
}

function ServicesTableSkeleton() {
  return (
    <div className="space-y-2" data-testid="services-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function ServicesTableError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load service revenue</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}
