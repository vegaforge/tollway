# Plan: Agent detail page (2026-11-19)

- **ADR:** [ADR-2026-11-19-agent-detail-page](../adr/ADR-2026-11-19-agent-detail-page.md)
- **Issue:** #236

## Boundaries

Changes are confined to `apps/dashboard/src/data/agent-detail.ts`, `apps/dashboard/src/data/use-agent-detail.ts`, a new `apps/dashboard/src/app/agents/[agentId]/` route and view, the existing `apps/dashboard/src/app/agents/agents-view.tsx`, `docs/dashboard-data-contracts.md`, and a release note. No `packages/*` source, dependency manifest, config, or workflow changes. No new dependencies and no changeset.

## Interfaces

```ts
type AgentDetail = {
  id: string;
  label: string;
  payerAddresses: string[];
  series: { asset: string; points: { bucket: string; amount: string }[] }[];
  byModel: { model: SettlementModel; amount: string }[];
  byPayee: { payee: string; amount: string }[];
  policy: {
    document: Policy;
    daily: { budget: string | null; usedByAsset: { asset: string; amount: string }[] };
    total: { budget: string | null; usedByAsset: { asset: string; amount: string }[] };
    perService: { payee: string; cap: string | null; usedByAsset: { asset: string; amount: string }[] }[];
  } | null;
  recentStops: { at: string; rule: string; detail: string }[];
};

function fetchAgentDetail(agentId: string): Promise<AgentDetail>;
function useAgentDetail(agentId: string): UseAgentDetailState;
function percentage(used: bigint, budget: bigint): bigint;
function bucketSeries(metrics: PaymentMetric[], bucket: "hour" | "day"): SeriesPoint[];
```

`UseAgentDetailState` is `loading | error | ready` with the same shape as `UseAgentSpendState`. Amounts stay integer base-unit strings; `percentage` multiplies before dividing and returns basis points for display.

## State changes

None. The deterministic stub holds no mutable state and the dashboard has no persistence layer in this issue.

## Test strategy

Write failing tests first: `agent-detail.test.ts` for bigint percentage boundaries (0, 100, over 100, large values) and hour/day bucketing with settled-only filtering; `agent-detail-view.test.tsx` for loading, error, no-policy, multi-asset, and budget at 0%, 100%, and over 100%, plus the policy-stop link. Extend `agents-view.test.tsx` for the row link and the multi-asset headline fix. All run through Vitest in `apps/dashboard`; no adapter changes.

## Steps

1. Flip both ADRs to Accepted and write this plan.
2. Add the failing tests and run `pnpm --filter @vegaforge/tollway-dashboard test` to confirm they fail for the missing feature.
3. Add `agent-detail.ts` with the type, stub, `percentage`, and `bucketSeries`; add `use-agent-detail.ts`.
4. Add the `[agentId]` page and view; link table rows and fix the headline totals.
5. Update the data contracts document and add the release note.
6. Run `./scripts/preflight.sh` in full, then exercise the flow in the built dashboard.
7. Commit and open the pull request against `dev` with `Closes #236`.
