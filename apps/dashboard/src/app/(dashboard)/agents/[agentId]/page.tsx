import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent detail" };

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return (
    <>
      <PageHeader title="Agent detail" lead="Spend, budget usage, and policy stops." />
      <AgentDetailView agentId={agentId} />
    </>
  );
}
