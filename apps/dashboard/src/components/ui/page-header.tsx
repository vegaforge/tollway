import type { ReactNode } from "react";

/** Standard heading for every dashboard view: title, optional lead, optional action. */
export function PageHeader({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
        {lead && <p className="mt-1 max-w-2xl text-sm text-muted">{lead}</p>}
      </div>
      {action}
    </header>
  );
}
