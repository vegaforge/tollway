import { settlementModels } from "@tollway/core";
import { StatCard } from "./components/stat-card";

// This page is a scaffold. The figures below are placeholders until the
// observability hub is implemented and feeding live data. See
// docs/design.md, "Observability", and @tollway/observability.

const modelLabels: Record<string, string> = {
  x402: "x402 per-request",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tollway</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Spend, latency, and failures across agent payment models
          </p>
        </div>
        <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
          Scaffold
        </span>
      </header>

      <section className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total spend" value="—" hint="awaiting observability hub" />
        <StatCard label="Payments" value="—" hint="settled this period" />
        <StatCard label="Open channels" value="—" hint="with remaining budget" />
        <StatCard label="Failure rate" value="—" hint="across all models" />
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-foreground/70">Model mix</h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {settlementModels.map((model) => (
            <div key={model} className="rounded-xl border border-border bg-surface p-5">
              <p className="text-sm font-medium">{modelLabels[model] ?? model}</p>
              <p className="mt-2 text-2xl font-semibold text-accent">—</p>
              <p className="mt-1 text-xs text-foreground/50">share of spend</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-12 border-t border-border pt-6 text-xs text-foreground/50">
        Wire these widgets to <code>@tollway/observability</code> to replace the placeholders. See
        the observability section of the design document.
      </footer>
    </main>
  );
}
