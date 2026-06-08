// Landing page. A Server Component; the theme toggle is the only client piece.
// Colors come from the token utilities in globals.css, never hardcoded hex.

import type { Metadata } from "next";
import Link from "next/link";
import { FeatureGrid } from "@/components/feature-grid";
import { FlowDiagram } from "@/components/flow-diagram";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Tollway — orchestration, policy, and observability for agent payments on Stellar",
  description:
    "Tollway is an orchestration, policy, and observability layer for agent payments on Stellar. It composes x402 and MPP, routes the model per counterparty, runs channel lifecycles, enforces budgets, and writes one signed receipt per settlement. It never custodies funds.",
};

function SectionLabel({ index, title, lead }: { index: string; title: string; lead?: string }) {
  return (
    <div className="reveal mb-10 flex flex-wrap items-baseline gap-x-[14px] gap-y-2">
      <span className="font-mono text-[12px] tracking-[0.1em] text-primary">{index}</span>
      <h2 className="text-[clamp(22px,3vw,30px)] font-semibold tracking-[-0.02em]">{title}</h2>
      {lead && (
        <p className="max-w-[360px] text-[14.5px] text-muted md:ml-auto md:text-right">{lead}</p>
      )}
    </div>
  );
}

const notList = [
  {
    title: "Not a facilitator",
    body: "It does not stand between you and the network or move money on your behalf. The primitives still talk to Stellar directly.",
  },
  {
    title: "Not a base SDK",
    body: "x402 and MPP keep their own SDKs. Tollway calls them and adds orchestration on top. It does not replace them.",
  },
  {
    title: "Never custodies funds",
    body: "Agents and services hold their own keys. Tollway reads, routes, and records. It never takes custody of a balance.",
  },
];

const audiences = [
  {
    tag: "Service operators",
    title: "Get paid by agent traffic",
    body: "Monetize an API, dataset, or inference endpoint for agents, and bill every call with one receipt format regardless of model.",
  },
  {
    tag: "Agent developers",
    title: "Pay many services cleanly",
    body: "Ship agents that pay across services without writing channel logic, budget enforcement, or per-model accounting yourself.",
  },
  {
    tag: "Platform integrators",
    title: "Embed payments for tenants",
    body: "Put agent payments inside a platform and give every tenant the same policy controls and observability out of the box.",
  },
];

export default function Page() {
  return (
    <>
      <SiteHeader />

      <div className="mx-auto max-w-[1320px] border-x border-border" id="top">
        <main>
          {/* HERO */}
          <div className="mx-auto max-w-[1320px] px-6">
            <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="flex flex-col items-start gap-[26px] py-14 lg:py-[78px] lg:pr-12">
                <span className="inline-flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.12em] text-muted">
                  <span className="inline-flex gap-[3px]" aria-hidden="true">
                    <i className="h-[3px] w-[14px] rounded-[1px] bg-primary" />
                    <i className="h-[3px] w-[14px] rounded-[1px] bg-accent" />
                  </span>
                  Built on Stellar · x402 and MPP
                </span>

                <h1 className="max-w-[14ch] text-[clamp(34px,5vw,56px)] font-semibold leading-[1.02] tracking-[-0.03em]">
                  The orchestration layer for <span className="text-primary">agent payments</span>{" "}
                  on Stellar.
                </h1>

                <p className="max-w-[52ch] text-[clamp(16px,1.6vw,18px)] leading-[1.6] text-muted text-pretty">
                  Stellar ships two agent payment primitives: x402 settles one payment per request,
                  and MPP adds a channel mode where an agent deposits once and streams thousands of
                  signed commitments, settled in a single transaction at close. Tollway composes
                  both. It picks the model per counterparty, runs channel lifecycles, enforces
                  budgets, and turns every settlement into one signed receipt. It orchestrates the
                  payments and never holds the funds.
                </p>

                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/docs"
                    className="inline-flex h-[46px] items-center gap-[9px] whitespace-nowrap rounded-[10px] bg-primary px-5 text-[15px] font-medium text-primary-foreground transition-shadow hover:shadow-[0_6px_22px_-8px_var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
                  >
                    Read the docs
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-[17px] w-[17px]"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                  <a
                    href="https://github.com/vegaforge/tollway"
                    className="inline-flex h-[46px] items-center gap-[9px] whitespace-nowrap rounded-[10px] border border-border-strong bg-surface px-5 text-[15px] font-medium text-foreground transition-colors hover:border-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="h-[17px] w-[17px]"
                      aria-hidden="true"
                    >
                      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9v2.81c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
                    </svg>
                    View on GitHub
                  </a>
                </div>

                <span className="inline-flex flex-wrap items-center gap-[10px] pt-[6px] font-mono text-[12.5px] text-muted">
                  Composes
                  <code className="rounded-md border border-border bg-surface-2 px-[7px] py-[2px] text-[12px] text-foreground">
                    @x402/stellar
                  </code>
                  and
                  <code className="rounded-md border border-border bg-surface-2 px-[7px] py-[2px] text-[12px] text-foreground">
                    @stellar/mpp
                  </code>
                </span>
              </div>

              <div className="flex items-center border-t border-border py-11 lg:border-t-0 lg:border-l lg:py-10 lg:pl-12">
                <FlowDiagram />
              </div>
            </div>
          </div>

          {/* CAPABILITIES */}
          <section className="border-t border-border" aria-labelledby="cap-h">
            <div className="mx-auto max-w-[1320px] px-6 py-20 md:py-[84px]">
              <SectionLabel
                index="/ capabilities"
                title="Six jobs, one layer"
                lead="Everything Tollway does sits above the payment primitives and leaves them untouched."
              />
              <FeatureGrid />
            </div>
          </section>

          {/* WHAT TOLLWAY IS NOT */}
          <section className="border-t border-border bg-surface-2" aria-labelledby="isnot-h">
            <div className="mx-auto max-w-[1320px] px-6 py-20 md:py-[84px]">
              <SectionLabel
                index="/ scope"
                title="What Tollway is not"
                lead="A thin layer with a narrow job. It sits above @x402/stellar and @stellar/mpp and composes them."
              />
              <div className="reveal grid grid-cols-1 overflow-hidden rounded-[14px] border border-border bg-border [gap:1px] md:grid-cols-3">
                {notList.map((n) => (
                  <div key={n.title} className="bg-surface px-[26px] py-7">
                    <span className="mb-[10px] grid grid-cols-[20px_1fr] items-center gap-[10px] text-[16px] font-semibold">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="h-[18px] w-[18px] text-primary"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                      {n.title}
                    </span>
                    <p className="text-[14px] text-muted">{n.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* WHO IT IS FOR */}
          <section className="border-t border-border" aria-labelledby="aud-h">
            <div className="mx-auto max-w-[1320px] px-6 py-20 md:py-[84px]">
              <SectionLabel index="/ who it is for" title="Built for both sides of the meter" />
              <div className="reveal grid grid-cols-1 gap-x-7 md:grid-cols-3">
                {audiences.map((a, i) => (
                  <div
                    key={a.tag}
                    className={
                      "border-t pt-[22px] " +
                      (i === 0
                        ? "border-t-2 border-foreground"
                        : "border-border pb-[22px] md:border-t-2 md:border-foreground md:pb-0")
                    }
                  >
                    <span className="mb-[14px] block font-mono text-[11px] uppercase tracking-[0.1em] text-primary">
                      {a.tag}
                    </span>
                    <h3 className="mb-2 text-[16px] font-semibold">{a.title}</h3>
                    <p className="text-[14px] text-muted">{a.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* CLOSING CTA */}
          <section className="border-t border-border" aria-labelledby="cta-h">
            <div className="mx-auto max-w-[1320px] px-6 py-20 md:py-[84px]">
              <div className="reveal flex flex-col items-center gap-5 rounded-2xl border border-border bg-surface-2 px-8 py-16 text-center max-[560px]:px-[22px] max-[560px]:py-11">
                <span className="inline-flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.12em] text-muted">
                  <span className="inline-flex gap-[3px]" aria-hidden="true">
                    <i className="h-[3px] w-[14px] rounded-[1px] bg-primary" />
                    <i className="h-[3px] w-[14px] rounded-[1px] bg-accent" />
                  </span>
                  Built on Stellar · x402 and MPP
                </span>
                <h2
                  id="cta-h"
                  className="max-w-[18ch] text-[clamp(28px,4vw,42px)] font-semibold leading-[1.05] tracking-[-0.025em]"
                >
                  Put one layer over your agent payments.
                </h2>
                <p className="max-w-[54ch] text-[16.5px] leading-[1.55] text-muted text-pretty">
                  Read how Tollway routes, settles, and reconciles, then wire it above your existing
                  x402 and MPP setup. It is open source and never touches your funds.
                </p>
                <div className="mt-1 flex flex-wrap justify-center gap-3">
                  <Link
                    href="/docs"
                    className="inline-flex h-[46px] items-center gap-[9px] whitespace-nowrap rounded-[10px] bg-primary px-5 text-[15px] font-medium text-primary-foreground transition-shadow hover:shadow-[0_6px_22px_-8px_var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
                  >
                    Read the docs
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-[17px] w-[17px]"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                  <a
                    href="https://github.com/vegaforge/tollway"
                    className="inline-flex h-[46px] items-center gap-[9px] whitespace-nowrap rounded-[10px] border border-border-strong bg-surface px-5 text-[15px] font-medium text-foreground transition-colors hover:border-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="h-[17px] w-[17px]"
                      aria-hidden="true"
                    >
                      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9v2.81c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
                    </svg>
                    View on GitHub
                  </a>
                </div>
                <span className="mt-[6px] inline-flex items-center gap-2 font-mono text-[12px] tracking-[0.04em] text-muted before:h-[7px] before:w-[7px] before:rounded-full before:bg-accent before:content-['']">
                  Pre-release. Interfaces will change before a tagged release.
                </span>
              </div>
            </div>
          </section>
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
