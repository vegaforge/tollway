import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Channels" };

export default function ChannelsPage() {
  return (
    <>
      <PageHeader
        title="Channels"
        lead="Open MPP channels, their cumulative commitments, and remaining budget before close."
      />
      <Panel
        title="Open channels"
        description="Counterparty, committed amount, deposit, and status"
      >
        <EmptyState
          title="No open channels"
          body="Build the channel table here: cumulative committed vs deposit, sequence, and close or recovery state."
          source="@tollway/channels · Channel"
        />
      </Panel>
    </>
  );
}
