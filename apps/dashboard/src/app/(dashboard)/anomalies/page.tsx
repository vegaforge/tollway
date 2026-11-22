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
  const agentFilter = typeof agent === "string" && agent.length > 0 ? agent : null;

  return (
    <>
      <PageHeader
        title="Anomalies"
        lead="Spend spikes and policy stops as they fire, with the records that triggered them."
      />
      <AnomaliesView agentFilter={agentFilter} />
    </>
  );
}
