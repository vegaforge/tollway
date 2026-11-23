/**
 * A small indicator that shows the SSE stream connection state.
 *
 * Rendered by views that use the live stream so users can tell whether
 * they are seeing real-time data or a stale snapshot.
 *
 * Variants:
 *   live        – green dot, "Live"
 *   connecting  – pulsing grey dot, "Connecting"
 *   reconnecting – pulsing amber dot, "Reconnecting"
 *   paused      – grey dot, "Paused"
 */

import type { StreamStatus } from "@/data/use-event-stream";

const VARIANTS: Record<StreamStatus, { dot: string; label: string; pulse: boolean }> = {
  live: { dot: "bg-success", label: "Live", pulse: false },
  connecting: { dot: "bg-muted", label: "Connecting", pulse: true },
  reconnecting: { dot: "bg-warning", label: "Reconnecting", pulse: true },
  paused: { dot: "bg-muted", label: "Paused", pulse: false },
};

export function StreamStatusBadge({
  status,
  className,
}: {
  status: StreamStatus;
  className?: string;
}) {
  const { dot, label, pulse } = VARIANTS[status];
  return (
    <span
      role="status"
      data-testid={`stream-status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted ${className ?? ""}`}
      aria-label={`Stream: ${label}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
