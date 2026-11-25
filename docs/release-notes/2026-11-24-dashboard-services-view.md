---
date: 2026-11-24
feature: Dashboard services view with revenue, model mix and latency per payee
scope: feat
packages: []
scenario-impact: none
---

# Dashboard services view

The dashboard's Services page used to show a placeholder. It now lists every
service (a payee, the address a paid route settles to) with its settled
revenue, the number of settled payments, the mix of settlement models, and the
average latency of each model. The table sorts by revenue or by payment count,
and three headline cards show total revenue per asset, settled payments, and
the number of services. With no settled payments it shows the shared empty
state. Closes #108.

The page reads `useServiceRevenue()`, which wraps `fetchServiceRevenue()` in
`apps/dashboard/src/data/service-revenue.ts`. That function fills an
`@vegaforge/tollway-observability` hub with deterministic stub payments and
builds one row per payee and asset from the hub's `summarizeAsync` (revenue,
counts, model mix) and `queryMetrics` (latency). Only settled payments count,
and amounts in different assets are never added. Revenue is an integer
base-unit string, summed and sorted as `BigInt` and formatted only for display.
Swapping the stub hub for the live one changes `fetchServiceRevenue` and
nothing downstream. The contract is in docs/dashboard-data-contracts.md,
"Services contract".

Coverage: unit tests for the data module, the hook and the view, and browser
tests for sorting by mouse and keyboard and for accessibility (axe, WCAG 2.1
AA) in the light, dark and mobile projects.

scenario-impact is `none`: the change is a read-only dashboard view and touches
no payment behaviour.
