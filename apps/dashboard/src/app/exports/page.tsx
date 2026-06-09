import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Exports" };

export default function ExportsPage() {
  return (
    <>
      <PageHeader
        title="Exports"
        lead="Machine-readable exports and outgoing webhooks for downstream accounting and integration."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Exports" description="Download a range as JSON or CSV">
          <EmptyState
            title="No exports configured"
            body="Build the export controls here: pick a range and format, then stream the receipts out."
            source="@tollway/observability · export()"
          />
        </Panel>
        <Panel title="Webhooks" description="Push events to your own endpoints">
          <EmptyState
            title="No webhooks configured"
            body="Build webhook management here for receipt.created, channel.opened and closed, budget.warning, and anomaly.detected."
            source="@tollway/observability · WebhookEvent"
          />
        </Panel>
      </div>
    </>
  );
}
