import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ReceiptsView } from "./receipts-view";

export const metadata: Metadata = { title: "Receipts" };

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        lead="The canonical signed receipt archive: searchable, filterable, and exportable."
      />
      <ReceiptsView />
    </>
  );
}
