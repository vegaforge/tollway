import { settlementModels } from "@tollway/core";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";

// Overview is the worked example of the dashboard's composition: stat cards on
// top, then panels for each observability view. Every value is a placeholder
// until the data layer is wired. Each empty state names its source so a
// contributor knows exactly what to connect. See docs/design.md, "Observability".

const modelLabels: Record<string, string> = {
  x402: "x402 per-request",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

const stats = [
  { label: "Total spend", hint: "across all models" },
  { label: "Payments settled", hint: "this period" },
  { label: "Open channels", hint: "with remaining budget" },
  { label: "Failure rate", hint: "verify and settle" },
];

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        lead="Spend, model mix, failures, and open channels at a glance. Wire the widgets to @tollway/observability to replace the placeholders."
      />

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} label={s.label} value="—" hint={s.hint} />
        ))}
      </section>

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
            source="@tollway/observability · summarize()"
          />
        </Panel>

        <Panel title="Recent receipts" description="The canonical signed receipt stream">
          <EmptyState
            title="No receipts yet"
            body="Settled payments appear here as canonical receipts, newest first."
            source="@tollway/core · SignedReceipt"
          />
        </Panel>

        <Panel title="Anomalies" description="Spend spikes and policy stops">
          <EmptyState
            title="Nothing flagged"
            body="Anomaly events and budget stops surface here as they fire."
            source="@tollway/observability · anomaly.detected"
          />
        </Panel>
      </div>
    </>
  );
}
