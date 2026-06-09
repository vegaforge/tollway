import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Services" };

export default function ServicesPage() {
  return (
    <>
      <PageHeader
        title="Services"
        lead="Per-service revenue, the mix of settlement models in use, and latency per model."
      />
      <Panel title="Services" description="One row per service, with revenue and model mix">
        <EmptyState
          title="No service data yet"
          body="Build the per-service table and latency breakdown here, grouped by settlement model."
          source="@tollway/observability · summarize({ payee })"
        />
      </Panel>
    </>
  );
}
