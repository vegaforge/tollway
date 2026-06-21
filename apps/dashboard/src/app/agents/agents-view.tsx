"use client";

import { useMemo, useState } from "react";

import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import type { AgentSpendRow } from "@/data/agent-spend";
import { useAgentSpend } from "@/data/use-agent-spend";

/**
 * Default precision used to render integer-string amounts. Stellar SACs (the
 * settlement target of @tollway/core) use 7 decimal places. When the
 * observability hub starts attaching per-asset metadata to rows, the data
 * layer can override this.
 */
const DEFAULT_ASSET_DECIMALS = 7;

type SortDirection = "asc" | "desc";

function compareSpend(a: AgentSpendRow, b: AgentSpendRow, direction: SortDirection): number {
  const left = BigInt(a.spend);
  const right = BigInt(b.spend);
  if (left === right) return 0;
  const ascending = left < right ? -1 : 1;
  return direction === "asc" ? ascending : -ascending;
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

function sumAmounts(rows: AgentSpendRow[], pick: (row: AgentSpendRow) => string): bigint {
  return rows.reduce((acc, row) => acc + BigInt(pick(row)), 0n);
}

function headlineAsset(rows: AgentSpendRow[]): string {
  return rows[0]?.asset ?? "USDC";
}

export function AgentsView() {
  const state = useAgentSpend();
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const rows = state.status === "ready" ? state.rows : [];

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareSpend(a, b, sortDirection)),
    [rows, sortDirection],
  );

  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { spend: "0", budget: "0", asset: "USDC" };
    }
    return {
      spend: sumAmounts(rows, (r) => r.spend).toString(),
      budget: sumAmounts(rows, (r) => r.budget).toString(),
      asset: headlineAsset(rows),
    };
  }, [rows]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total spend"
          value={state.status === "ready" ? formatAmount(totals.spend, totals.asset) : "-"}
          hint="Cumulative across all agents"
        />
        <StatCard
          label="Total budget"
          value={state.status === "ready" ? formatAmount(totals.budget, totals.asset) : "-"}
          hint="Remaining across all agents"
        />
        <StatCard
          label="Agents"
          value={state.status === "ready" ? rows.length : "-"}
          hint="Tracked by the observability hub"
        />
      </div>

      <Panel
        title="Per-agent spend"
        description="Sorted by spend. Reads from @tollway/observability once the hub lands."
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
                className="inline-flex items-center gap-1 font-medium uppercase tracking-wide text-muted hover:text-foreground"
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
                <span className="font-medium">{row.label}</span>
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
