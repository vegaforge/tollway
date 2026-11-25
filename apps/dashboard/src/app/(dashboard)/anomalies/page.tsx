import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { AnomaliesView } from "./anomalies-view";

export const metadata: Metadata = { title: "Anomalies" };

export default async function AnomaliesPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[] }>;
}) {
  const { agent } = await searchParams;
  // The agent detail page links here with ?agent=<id>.
  const agentFilter = typeof agent === "string" && agent.length > 0 ? agent : null;

  return (
    <>
      <PageHeader
        title="Anomalies"
        lead="Policy stops, spend spikes, budget warnings, and reconciliation drift, newest first, with the records behind them."
      />
      <AnomaliesView agentId={agentFilter} />
    </>
  );
}
