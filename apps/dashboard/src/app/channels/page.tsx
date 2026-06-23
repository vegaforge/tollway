import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ChannelsView } from "./channels-view";

export const metadata: Metadata = { title: "Channels" };

export default function ChannelsPage() {
  return (
    <>
      <PageHeader
        title="Channels"
        lead="Open MPP channels, their cumulative commitments, and remaining budget before close."
      />
      <ChannelsView />
    </>
  );
}
