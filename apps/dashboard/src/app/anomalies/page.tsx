import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Anomalies" };

export default function AnomaliesPage() {
  return (
    <>
      <PageHeader
        title="Anomalies"
        lead="Spend spikes and policy stops as they fire, with the records that triggered them."
      />
      <Panel title="Anomaly events" description="Type, counterparty, and the rule that tripped">
        <EmptyState
          title="Nothing flagged"
          body="Build the anomaly feed here: budget stops, sudden spend spikes, and reconciliation drift, newest first."
          source="@tollway/observability · anomaly.detected"
        />
      </Panel>
    </>
  );
}
