import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Receipts" };

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        lead="The canonical signed receipt archive: searchable, filterable, and exportable."
      />
      <Panel title="Receipts" description="Payer, payee, amount, model, and settlement reference">
        <EmptyState
          title="No receipts yet"
          body="Build the receipt table and a detail view here. Verify each signature and link channel receipts to their channel."
          source="@tollway/core · SignedReceipt"
        />
      </Panel>
    </>
  );
}
