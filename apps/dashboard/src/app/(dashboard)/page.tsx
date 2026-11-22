import { settlementModels } from "@vegaforge/tollway-core";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { OverviewLiveSection } from "./overview-live-section";

// Overview shows how the dashboard composes: stat cards over panels, one per
// observability view. Values are placeholders until the data is wired, and each
// empty state names its source. See docs/design.md, "Observability".

const modelLabels: Record<string, string> = {
  x402: "x402 per-request",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        lead="Spend, model mix, failures, and open channels at a glance."
      />
      <OverviewLiveSection />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Model mix" description="Share of spend by settlement model">
          <ul className="grid grid-cols-3 gap-3">
            {settlementModels.map((model) => (
              <li key={model} className="rounded-lg border border-border bg-surface-2 p-4">
                <p className="text-xs font-medium">{modelLabels[model] ?? model}</p>
                <p className="mt-2 text-xl font-semibold text-accent">—</p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Spend over time" description="Per-agent and per-service totals">
          <EmptyState
            title="No spend data yet"
            body="A time series of spend by agent and service will render here."
            source="@vegaforge/tollway-observability · summarize()"
          />
        </Panel>

        <Panel title="Recent receipts" description="The canonical signed receipt stream">
          <EmptyState
            title="No receipts yet"
            body="Settled payments appear here as canonical receipts, newest first."
            source="@vegaforge/tollway-core · SignedReceipt"
          />
        </Panel>

        <Panel title="Anomalies" description="Spend spikes and policy stops">
          <EmptyState
            title="Nothing flagged"
            body="Anomaly events and budget stops surface here as they fire."
            source="@vegaforge/tollway-observability · anomaly.detected"
          />
        </Panel>
      </div>
    </>
  );
}
