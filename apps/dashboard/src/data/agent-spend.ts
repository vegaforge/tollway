/**
 * Typed data layer for the agents view.
 *
 * The agents view (src/app/agents/page.tsx) depends on @tollway/observability,
 * which is tracked in issue #31. Until #31 lands, this module is the single
 * seam where the UI talks to the data. Replacing `fetchAgentSpend` with a real
 * call to the observability hub is a one-import change; everything downstream
 * (the row shape, the loading/error states, the table) stays the same.
 *
 * See docs/design.md, "Observability".
 */

/**
 * One row in the per-agent spend table. Amounts are integer strings in the
 * asset's smallest unit, matching the canonical receipt and policy shapes in
 * @tollway/core. The table formats them for display; the data layer does not.
 */
export type AgentSpendRow = {
  /** Stable id for the agent, used as the React key. */
  id: string;
  /** Human-readable label rendered in the agent column. */
  label: string;
  /** Cumulative spend in the asset's smallest unit. */
  spend: string;
  /** Remaining budget in the asset's smallest unit. */
  budget: string;
  /** Asset code, e.g. "USDC". */
  asset: string;
};

/**
 * Snapshot returned by the data source. Wrapping the rows in an object keeps
 * the seam stable when the observability hub starts returning metadata
 * alongside the list (cursors, generated-at timestamps, and so on) without
 * forcing every consumer to update.
 */
export type AgentSpendSnapshot = {
  rows: AgentSpendRow[];
};

/**
 * The single seam between the dashboard and the observability hub.
 *
 * Today this returns a small, deterministic stub so the UI, the sort
 * behavior, and the empty/error states all light up without waiting on #31.
 * When the hub ships, swap the body for `summarize({ payer })` per agent or
 * a future `byPayer()` rollup and leave the signature alone.
 */
export async function fetchAgentSpend(): Promise<AgentSpendSnapshot> {
  return { rows: STUB_ROWS };
}

const STUB_ROWS: AgentSpendRow[] = [
  {
    id: "agent-research-01",
    label: "research-bot",
    spend: "1842500000",
    budget: "5000000000",
    asset: "USDC",
  },
  {
    id: "agent-summarizer-02",
    label: "summarizer",
    spend: "734200000",
    budget: "2000000000",
    asset: "USDC",
  },
  {
    id: "agent-classifier-03",
    label: "classifier",
    spend: "215000000",
    budget: "1000000000",
    asset: "USDC",
  },
  {
    id: "agent-router-04",
    label: "router",
    spend: "98000000",
    budget: "500000000",
    asset: "USDC",
  },
];
