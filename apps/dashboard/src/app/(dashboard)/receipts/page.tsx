import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ReceiptsView } from "./receipts-view";

export const metadata: Metadata = { title: "Receipts" };

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ payee?: string | string[] }>;
}) {
  const { payee } = await searchParams;
  // The anomaly feed links here with ?payee=<counterparty>.
  const payeeFilter = typeof payee === "string" && payee.length > 0 ? payee : null;
  return (
    <>
      <PageHeader
        title="Receipts"
        lead="The canonical signed receipt archive: searchable, filterable, and exportable."
      />
      <ReceiptsView payee={payeeFilter} />
    </>
  );
}
