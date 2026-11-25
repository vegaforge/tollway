import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ServicesView } from "./services-view";

export const metadata: Metadata = { title: "Services" };

export default function ServicesPage() {
  return (
    <>
      <PageHeader
        title="Services"
        lead="Per-service revenue, the mix of settlement models in use, and latency per model."
      />
      <ServicesView />
    </>
  );
}
