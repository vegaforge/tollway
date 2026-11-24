import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ChannelDetailView } from "./channel-detail-view";

export const metadata: Metadata = { title: "Channel detail" };

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = await params;
  return (
    <>
      <PageHeader
        title="Channel detail"
        lead="One channel's cumulative commitments against its deposit, its reconciliation result, and the receipts it settles."
      />
      <ChannelDetailView channelId={channelId} />
    </>
  );
}
