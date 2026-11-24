import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Anomalies" };

export default async function AnomaliesPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[] }>;
}) {
  const { agent } = await searchParams;
  // The agent detail page links here with ?agent=<id>. The feed itself is not
  // wired yet; the filter is shown so the link lands somewhere that says so.
  const agentFilter = typeof agent === "string" && agent.length > 0 ? agent : null;

  return (
    <>
      <PageHeader
        title="Anomalies"
        lead="Spend spikes and policy stops as they fire, with the records that triggered them."
      />
      {agentFilter ? (
        <p data-testid="anomalies-agent-filter" className="mb-4 text-sm">
          Showing events for agent <span className="font-mono">{agentFilter}</span>.{" "}
          <Link className="underline" href="/anomalies">
            Show all agents
          </Link>
        </p>
      ) : null}
      <Panel title="Anomaly events" description="Type, counterparty, and the rule that tripped">
        <EmptyState
          title="Nothing flagged"
          body="Build the anomaly feed here: budget stops, sudden spend spikes, and reconciliation drift, newest first."
          source="@vegaforge/tollway-observability · anomaly.detected"
        />
      </Panel>
    </>
  );
}
