import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        lead="Per-agent spend over time, model mix, and budget usage, with anomaly stops surfaced inline."
      />
      <Panel title="Agents" description="One row per agent, with spend and remaining budget">
        <EmptyState
          title="No agent data yet"
          body="Build the per-agent table and spend chart here. Sort by spend, filter by service, and link each row to its receipts."
          source="@tollway/observability · summarize({ payer })"
        />
      </Panel>
    </>
  );
}
