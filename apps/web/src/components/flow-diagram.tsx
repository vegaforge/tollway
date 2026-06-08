// components/flow-diagram.tsx
// Static schematic of the payment flow: 402 challenge -> sign -> settle -> receipt.
// Pure Server Component, no client JS.

const steps = [
  {
    n: "01",
    title: "402 challenge",
    body: "The service answers a request with a price and asset to pay.",
  },
  {
    n: "02",
    title: "Sign",
    body: "The agent signs a payment commitment within its budget.",
  },
  {
    n: "03",
    title: "Settle",
    body: "Tollway routes the commitment to one model:",
    branch: [
      { label: "x402", note: "· one payment per request", accent: false },
      { label: "MPP charge", note: "· one payment per request", accent: false },
      { label: "MPP channel", note: "· streamed, settled at close", accent: true },
    ],
  },
  {
    n: "04",
    title: "Signed receipt",
    body: "Any model produces one canonical record.",
    receipt: true,
  },
];

export function FlowDiagram() {
  return (
    <figure
      className="w-full overflow-hidden rounded-[14px] border border-border bg-surface shadow-xl"
      aria-label="Payment flow from 402 challenge to signed receipt"
    >
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-[13px]">
        <span className="flex gap-[6px]" aria-hidden="true">
          <i className="h-[9px] w-[9px] rounded-full bg-primary" />
          <i className="h-[9px] w-[9px] rounded-full bg-accent" />
          <i className="h-[9px] w-[9px] rounded-full bg-border-strong" />
        </span>
        <span className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-muted">
          Payment flow
        </span>
      </div>

      <ol className="px-[18px] pb-[18px] pt-2">
        {steps.map((s, i) => (
          <li key={s.n} className="relative grid grid-cols-[auto_1fr] gap-[14px] py-4">
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute left-[13px] top-[34px] bottom-[-8px] w-px bg-border-strong"
              />
            )}
            <span className="z-[1] grid h-[27px] w-[27px] place-items-center rounded-[7px] border border-border bg-surface-2 font-mono text-[12px] text-muted">
              {s.n}
            </span>
            <div>
              <span className="block text-[15px] font-semibold tracking-[-0.01em]">{s.title}</span>
              <span className="mt-[2px] block text-[13.5px] text-muted">{s.body}</span>

              {s.branch && (
                <ul className="mt-[11px] flex flex-col gap-[7px]">
                  {s.branch.map((b) => (
                    <li
                      key={b.label}
                      className="grid grid-cols-[11px_1fr] items-start gap-[10px] font-mono text-[12px] leading-[1.4]"
                    >
                      <span
                        className={
                          "mt-1 h-[9px] w-[9px] rounded-[2px] " +
                          (b.accent ? "bg-accent" : "bg-primary")
                        }
                      />
                      <span>
                        {b.label} <span className="text-muted">{b.note}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {s.receipt && (
                <div
                  aria-hidden="true"
                  className="mt-3 overflow-hidden rounded-[9px] border border-border bg-background"
                >
                  <div className="flex justify-between border-b border-dashed border-border-strong px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                    <span>receipt</span>
                    <span>rcpt_9f2a4c</span>
                  </div>
                  <div className="grid gap-[5px] px-3 py-[10px] font-mono text-[12.5px]">
                    <div className="flex justify-between">
                      <span className="text-muted">model</span>
                      <span>mpp.channel</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">amount</span>
                      <span>142.0000 USDC</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">commitments</span>
                      <span>1,284</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">status</span>
                      <span className="font-semibold text-accent">settled</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}
