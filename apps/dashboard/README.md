# Dashboard data contracts

The dashboard is the contributor surface for the observability plan in
`docs/design.md`, "Observability". Views should stay thin: each view renders a
stable UI contract, while `src/data/*` owns the seam that will later call
`@tollway/observability`.

## View contracts

| View | Route | Current source | Target contract |
| ---- | ----- | -------------- | --------------- |
| Overview | `src/app/page.tsx` | Placeholder `StatCard` values, `settlementModels` from `@tollway/core`, and `EmptyState` source labels. | Aggregate `PaymentMetric` rows through `ObservabilityHub.summarize()` for total spend, settled count, model mix, failures, open channels, recent receipts, and anomaly events. |
| Agents | `src/app/agents/page.tsx` and `src/app/agents/agents-view.tsx` | `useAgentSpend()` reads the typed stub in `src/data/agent-spend.ts`. | Replace `fetchAgentSpend()` with a hub-backed per-payer rollup, or a future `byPayer()` helper, while keeping `AgentSpendSnapshot` stable for the table. |
| Services | `src/app/services/page.tsx` | Empty table scaffold. | Group payment metrics by `payee`; use `summarize({ payee })` for revenue, model mix, latency, and failure totals. |
| Channels | `src/app/channels/page.tsx` | Empty open-channel scaffold. | Combine channel state from `@tollway/channels` with observability events such as `channel.opened` and `channel.closed` to show deposit, cumulative commitment, sequence, and close or recovery status. |
| Receipts | `src/app/receipts/page.tsx` | Empty receipt archive scaffold. | Render `SignedReceipt` rows from `@tollway/core`, verify signatures before display, and join channel receipts to their channel state when `settlement.kind` is `channel-commitment`. |
| Anomalies | `src/app/anomalies/page.tsx` | Empty anomaly feed scaffold. | Consume `TollwayEvent` entries for `budget.warning` and `anomaly.detected`, plus reconciliation drift events when that package emits them. |
| Exports | `src/app/exports/page.tsx` | Empty export and webhook scaffolds. | Call `ObservabilityHub.export("json" | "csv", query)` for downloads and manage handlers for the supported `WebhookEvent` names. |

## Data layer rules

- Put non-trivial data access in `src/data/*`, then expose a hook or fetch
  function to the route. `src/data/use-agent-spend.ts` is the pattern to copy.
- Keep amounts as integer strings in the asset's smallest unit until render
  time. UI components can format for display, but data contracts should match
  `@tollway/core` and `@tollway/observability`.
- Keep route components responsible for layout and state selection only.
  Sorting, formatting, loading, empty, and error states should be deterministic
  and testable before the real hub is implemented.
- Name the expected source in every placeholder so the next contributor knows
  which hub method or package type replaces it.

## UI primitives

### `Panel`

Use `Panel` for dashboard widgets that contain a chart, table, feed, control
surface, or empty state. It provides the widget title, optional description,
optional action slot, and body padding. Keep the data visualization inside the
panel body and use `className` only for layout spacing such as `mt-6`.

### `StatCard`

Use `StatCard` for a single headline metric: label, value, and optional hint.
Values can be numbers, formatted strings, a dash while data is unwired, or a
skeleton node while loading. Do not use `StatCard` for multi-row summaries or
interactive controls; those belong in a `Panel`.

### `EmptyState`

Use `EmptyState` inside a `Panel` when a view is scaffolded or a query returns
no rows. The `source` field should name the future data contract, for example
`@tollway/observability - summarize()` or `@tollway/core - SignedReceipt`.
When data lands, replace the empty body with the real visualization and keep
the surrounding `Panel` structure stable.
