import { PageHeader } from "@/components/ui/page-header";
import { OverviewView } from "./overview-view";

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        lead="Settled spend, payment outcomes, open channels, and the newest receipts and anomalies at a glance."
      />
      <OverviewView />
    </>
  );
}
