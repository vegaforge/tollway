"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { AssetTotals } from "@/components/ui/asset-totals";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import type { AgentSpendRow } from "@/data/agent-spend";
import { useAgentSpend } from "@/data/use-agent-spend";
import { formatAmount, sumByAsset } from "@/lib/amount";

type SortDirection = "asc" | "desc";

function compareSpend(a: AgentSpendRow, b: AgentSpendRow, direction: SortDirection): number {
  const left = BigInt(a.spend);
  const right = BigInt(b.spend);
  if (left === right) return 0;
  const ascending = left < right ? -1 : 1;
  return direction === "asc" ? ascending : -ascending;
}

export function AgentsView() {
  const state = useAgentSpend();
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const rows = state.status === "ready" ? state.rows : [];

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareSpend(a, b, sortDirection)),
    [rows, sortDirection],
  );

  const totals = useMemo(
    () => ({
      spend: sumByAsset(rows, (row) => row.spend),
      budget: sumByAsset(rows, (row) => row.budget),
    }),
    [rows],
  );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total spend"
          value={state.status === "ready" ? <AssetTotals entries={totals.spend} /> : "-"}
          hint="Per asset, cumulative across agents"
        />
        <StatCard
          label="Total budget"
          value={state.status === "ready" ? <AssetTotals entries={totals.budget} /> : "-"}
          hint="Per asset, remaining across agents"
        />
        <StatCard
          label="Agents"
          value={state.status === "ready" ? rows.length : "-"}
          hint="Tracked by the observability hub"
        />
      </div>

      <Panel
        title="Per-agent spend"
        description="Sorted by spend. Reads from @vegaforge/tollway-observability once the hub lands."
        className="mt-6"
      >
        {state.status === "loading" ? <AgentsTableSkeleton /> : null}
        {state.status === "error" ? <AgentsTableError error={state.error} /> : null}
        {state.status === "ready" ? (
          rows.length === 0 ? (
            <p className="text-sm text-muted">No agents have spent yet. Wire one up and reload.</p>
          ) : (
            <AgentsTable
              rows={sortedRows}
              sortDirection={sortDirection}
              onToggleSort={() => setSortDirection((prev) => (prev === "desc" ? "asc" : "desc"))}
            />
          )
        ) : null}
      </Panel>
    </>
  );
}

function AgentsTable({
  rows,
  sortDirection,
  onToggleSort,
}: {
  rows: AgentSpendRow[];
  sortDirection: SortDirection;
  onToggleSort: () => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Agent
            </th>
            <th
              scope="col"
              className="px-3 py-2 font-medium"
              aria-sort={sortDirection === "asc" ? "ascending" : "descending"}
            >
              <button
                type="button"
                onClick={onToggleSort}
                className="inline-flex items-center gap-1 rounded font-medium uppercase tracking-wide text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Spend
                <span aria-hidden="true">{sortDirection === "asc" ? "▲" : "▼"}</span>
              </button>
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Remaining budget
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-3">
                <Link
                  className="font-medium hover:underline"
                  href={`/agents/${encodeURIComponent(row.id)}`}
                >
                  {row.label}
                </Link>
                <span className="ml-2 font-mono text-xs text-muted">{row.id}</span>
              </td>
              <td className="px-3 py-3 font-mono">{formatAmount(row.spend, row.asset)}</td>
              <td className="px-3 py-3 font-mono text-muted">
                {formatAmount(row.budget, row.asset)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentsTableSkeleton() {
  return (
    <div className="space-y-2" data-testid="agents-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function AgentsTableError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load agent spend</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}
