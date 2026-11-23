"use client";

import Link from "next/link";

import { StreamStatusBadge } from "@/components/ui/stream-status-badge";
import { Panel } from "@/components/ui/panel";
import { type AnomalyRow, useAnomalies } from "@/data/use-anomalies";

function formatAt(at: string): string {
  // ISO 8601 → "YYYY-MM-DD HH:MM UTC"
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

export function AnomaliesView({ agentFilter }: { agentFilter: string | null }) {
  const state = useAnomalies(agentFilter ?? undefined);

  const rows = state.status === "ready" ? state.rows : [];

  return (
    <>
      {agentFilter ? (
        <p data-testid="anomalies-agent-filter" className="mb-4 text-sm">
          Showing events for agent <span className="font-mono">{agentFilter}</span>.{" "}
          <Link className="underline" href="/anomalies">
            Show all agents
          </Link>
        </p>
      ) : null}

      <Panel
        title="Anomaly events"
        description="Type, counterparty, and the rule that tripped"
        action={state.stream ? <StreamStatusBadge status={state.stream} /> : undefined}
      >
        {state.status === "loading" ? <AnomaliesSkeleton /> : null}
        {state.status === "ready" && rows.length === 0 ? (
          <p className="text-sm text-muted">
            No anomaly events yet. They will appear here live as they fire.
          </p>
        ) : null}
        {state.status === "ready" && rows.length > 0 ? (
          <AnomaliesTable rows={rows} />
        ) : null}
      </Panel>
    </>
  );
}

function AnomaliesTable({ rows }: { rows: AnomalyRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Agent
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Detail
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`anomaly-row-${row.id}`}
              className="border-b border-border last:border-b-0"
            >
              <td className="px-3 py-3">
                <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                  {row.type}
                </span>
              </td>
              <td className="px-3 py-3 font-mono text-xs text-muted">{row.agentId}</td>
              <td className="px-3 py-3 text-sm">{row.detail}</td>
              <td className="px-3 py-3 font-mono text-xs text-muted">{formatAt(row.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnomaliesSkeleton() {
  return (
    <div className="space-y-2" data-testid="anomalies-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}
