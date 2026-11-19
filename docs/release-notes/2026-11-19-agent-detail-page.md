---
date: 2026-11-19
feature: Agent detail page with per-asset spend, budget usage, and policy stops
scope: feat
packages: []
scenario-impact: none
---

# Agent detail page

Dashboard users can now open an agent from the Agents table and see that agent's settled spend over time per asset, its model mix, the services it pays, its budget usage against the policy that governs it, and its recent policy stops. Agents with no policy say so explicitly. Headline totals on the Agents page are grouped by asset instead of adding base units from different assets together.

The new data seam is `fetchAgentDetail` and `useAgentDetail` under `apps/dashboard/src/data/`, backed by a deterministic stub with an explicit agent-to-payer address map. Percentages use `bigint` basis-point math, the daily window is a UTC day, and the single-number budget's unit ambiguity is stated until budgets are keyed by asset. See [ADR-2026-11-19-agent-detail-page](../adr/ADR-2026-11-19-agent-detail-page.md) and the updated [dashboard data contracts](../dashboard-data-contracts.md).
