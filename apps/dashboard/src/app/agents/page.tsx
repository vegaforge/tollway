import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        lead="Per-agent spend over time, model mix, and budget usage, with anomaly stops surfaced inline."
      />
      <AgentsView />
    </>
  );
}
