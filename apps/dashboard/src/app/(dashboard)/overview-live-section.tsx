"use client";

import { StatCard } from "@/components/ui/stat-card";
import { StreamStatusBadge } from "@/components/ui/stream-status-badge";
import { useOverviewStats } from "@/data/use-overview-stats";

/**
 * The live counter section at the top of the Overview page.
 * Updates in place when `metrics.delta` events arrive.
 */
export function OverviewLiveSection() {
  const state = useOverviewStats();

  const settled = state.status === "ready" ? String(state.stats.settledCount) : ",";
  const openChannels = state.status === "ready" ? String(state.stats.openChannels) : ",";
  const anomalies = state.status === "ready" ? String(state.stats.anomalyCount) : ",";

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted">Running totals since service start</p>
        {state.stream ? <StreamStatusBadge status={state.stream} /> : null}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Payments settled" value={settled} hint="Cumulative since service start" />
        <StatCard label="Open channels" value={openChannels} hint="MPP channels currently open" />
        <StatCard
          label="Anomalies detected"
          value={anomalies}
          hint="Budget stops and spend spikes"
        />
      </div>
    </section>
  );
}
