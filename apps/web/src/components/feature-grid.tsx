// components/feature-grid.tsx
// The six core capabilities. Pure Server Component.

import type { ReactNode } from "react";

type Feature = { n: string; title: string; body: string; icon: ReactNode };

const I = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-full w-full"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const features: Feature[] = [
  {
    n: "01",
    title: "Model routing",
    body: "Tollway reads each counterparty's traffic shape and picks x402 per request, MPP charge, or an MPP channel. Override any choice when you already know the answer.",
    icon: I("M4 7h10M4 12h16M4 17h7"),
  },
  {
    n: "02",
    title: "Channel lifecycle",
    body: "Open channels, track cumulative commitments off chain, and close on the right trigger. When a counterparty goes quiet, Tollway recovers the channel instead of stranding funds.",
    icon: I("M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"),
  },
  {
    n: "03",
    title: "Policy and budgets",
    body: "Set per-agent and per-service caps, rate limits, and anomaly stops. Tollway maps them onto smart accounts where available and enforces them in the application layer everywhere else.",
    icon: I("M12 3l8 4v5c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V7z"),
  },
  {
    n: "04",
    title: "One canonical receipt",
    body: "Every settlement, on any model, becomes one signed receipt for accounting, dispute evidence, and analytics. You stop normalizing three formats by hand.",
    icon: I("M6 3h9l3 3v15l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6"),
  },
  {
    n: "05",
    title: "Reconciliation",
    body: "Off-chain commitments are checked against on-chain settlement after every close. When the two drift, Tollway flags the difference with the records behind it.",
    icon: I("M4 12a8 8 0 0 1 13-6m3 0v5h-5M20 12a8 8 0 0 1-13 6m-3 0v-5h5"),
  },
  {
    n: "06",
    title: "Observability",
    body: "Track spend, latency, and failure rates per agent, per service, and per model. Export the data or push it to a webhook.",
    icon: I("M4 19V5M4 19h16M8 16l4-5 3 3 5-7"),
  },
];

export function FeatureGrid() {
  return (
    <div className="reveal grid grid-cols-1 overflow-hidden rounded-[14px] border border-border bg-border [gap:1px] sm:grid-cols-2 lg:grid-cols-3">
      {features.map((f) => (
        <article
          key={f.n}
          className="group flex min-h-[210px] flex-col gap-[11px] bg-surface px-[26px] pb-8 pt-[30px] transition-colors hover:bg-surface-2"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] tracking-[0.08em] text-primary">{f.n}</span>
            <span className="h-[30px] w-[30px] text-muted transition-colors group-hover:text-primary">
              {f.icon}
            </span>
          </div>
          <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{f.title}</h3>
          <p className="text-[14px] leading-[1.55] text-muted">{f.body}</p>
        </article>
      ))}
    </div>
  );
}
