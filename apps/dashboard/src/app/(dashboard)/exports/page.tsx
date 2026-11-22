import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ExportsView } from "./exports-view";

export const metadata: Metadata = { title: "Exports" };

export default function ExportsPage() {
  return (
    <>
      <PageHeader
        title="Exports"
        lead="Machine-readable exports and outgoing webhooks for downstream accounting and integration."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ExportsView />
        <Panel title="Webhooks" description="Push events to your own endpoints">
          <EmptyState
            title="No webhooks configured"
            body="Build webhook management here for receipt.created, channel.opened and closed, budget.warning, and anomaly.detected."
            source="@vegaforge/tollway-observability · WebhookEvent"
          />
        </Panel>
      </div>
    </>
  );
}
