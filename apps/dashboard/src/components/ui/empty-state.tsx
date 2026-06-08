import type { ReactNode } from "react";

/**
 * The placeholder a widget shows until the data layer is wired. It names the
 * source so a contributor knows exactly what to connect and where the data
 * comes from. Replace the EmptyState with the real visualization; keep the
 * Panel around it.
 */
export function EmptyState({
  title,
  body,
  source,
  icon,
}: {
  title: string;
  body: string;
  /** Where the data will come from, e.g. "@tollway/observability · summarize()". */
  source?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-2 px-6 py-10 text-center">
      {icon && <span className="text-muted">{icon}</span>}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted">{body}</p>
      {source && (
        <code className="mt-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-muted">
          {source}
        </code>
      )}
    </div>
  );
}
