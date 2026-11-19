---
date: 2026-11-19
feature: Agent detail page with per-asset spend, budget usage, and policy stops
scope: feat
packages: []
scenario-impact: none
---

# Agent detail page

Dashboard users can open an agent from the Agents table and see its settled spend over time per asset, with an hour or day bucket and a 24-hour, 7-day or 30-day range; its model mix and the services it pays; its budget usage against the policy that governs it; and its recent policy stops, with a link to the anomalies view filtered to that agent. An agent with no policy says so instead of showing an empty bar. The Agents page headline totals are grouped by asset instead of adding base units of different assets together.

`fetchAgentDetail` and `useAgentDetail` in `apps/dashboard/src/data/` hold the seam. Spend comes from the observability hub's `timeseries` query, filtered by each of the agent's payer addresses, so it counts settled payments only and never mixes assets. Budget usage is measured over the windows the policy engine uses: the current UTC day for the daily budget, and the time since the policy took effect for the total budget and per-service caps. Percentages are `bigint` basis points, a zero limit gets no invented percentage, and spend over a limit is flagged. Policy stops are decision traces from the core engine's `evaluate`, parsed with `policyTraceSchema`. Data is a deterministic stub until the service metrics API (#226) and policy store (#228) land. See the [dashboard data contracts](../dashboard-data-contracts.md), "Agent detail contract", and [ADR-2026-11-19-agent-detail-page](../adr/ADR-2026-11-19-agent-detail-page.md) (proposed).
