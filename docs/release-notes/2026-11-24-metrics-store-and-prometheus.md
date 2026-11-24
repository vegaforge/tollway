---
date: 2026-11-24
feature: Durable metrics stores (memory, SQLite, Postgres) and a Prometheus exporter for the observability hub
scope: feat
packages: ["@vegaforge/tollway-observability"]
scenario-impact: none
---

# Durable metrics and a Prometheus exporter

Payment metrics can now outlive a restart and be shared by several gate
processes. `createObservabilityHub({ store })` takes a `MetricsStore`: an
in-memory one for tests, SQLite through the built-in `node:sqlite` at the new
`@vegaforge/tollway-observability/sqlite` entry, or Postgres through any client
with `query(text, params)`, so no driver becomes a dependency. `record` stays
synchronous: it validates the metric, rejecting a non-integer amount with
`InvalidMetricError`, and buffers it, and the buffer is written in batches.
`flush()` and `close()` drain it, and a failed write reaches the required
`onStoreError`. Stored metrics are read with `queryMetrics` (paged),
`summarizeAsync` and `exportAsync`. Every store returns the same summaries for
the same data, following the summary rules from #321: only settled payments add
to an amount, `count` and `byOutcome` cover every outcome, and the per-asset
breakdowns never add different assets. Amounts are summed exactly, and
queries filter by asset and outcome as well. The hub and the stores share one
implementation of those rules. It sums only plain integer strings, so a
malformed in-memory amount such as `-5` is skipped like any other non-integer
instead of reducing spend. Without a store the hub behaves as before. (#217)

`createPrometheusExporter({ hub })` serves the hub's counters in the text
exposition format 0.0.4: payments, settled amounts, a latency histogram, and
webhook deliveries and failures. Counters are kept incrementally, so they only
go up. Payer and payee are never labels unless a payee is allowlisted, and a
scrape can require a bearer token. The webhook dispatcher gains an
`onDelivered` callback, which the exporter uses to count outbox deliveries.
(#218)

The observability docs page covers choosing a store, flush semantics, mounting
the exporter in Express and Hono, and a metric reference.

Duplicate-settlement detection (#216) depends on the settlement log from #211,
and OpenTelemetry (#219) needs its dependency choice agreed in the issue
thread. Both are left for their own pull requests.

Pull request: #335.
