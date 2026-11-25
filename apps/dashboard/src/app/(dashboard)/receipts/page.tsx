import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { ReceiptsView } from "./receipts-view";

export const metadata: Metadata = { title: "Receipts" };

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // The anomaly feed links here with ?payee=<counterparty>. When present it
  // locks the view to one payee and hides the filter bar.
  const payee = typeof params.payee === "string" && params.payee.length > 0 ? params.payee : null;

  return (
    <>
      <PageHeader
        title="Receipts"
        lead="The canonical signed receipt archive: searchable, filterable, and exportable."
      />
      {/* Suspense is required by useSearchParams inside ReceiptsView. */}
      <Suspense fallback={null}>
        <ReceiptsView payee={payee} />
      </Suspense>
    </>
  );
}
