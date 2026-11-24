---
"@vegaforge/tollway-observability": minor
---

Add durable metrics stores (memory, SQLite at `/sqlite`, and Postgres through a
structural client) behind `createObservabilityHub({ store })`, with buffered
writes, `flush`, `close`, `onStoreError`, paged `queryMetrics`,
`summarizeAsync` and `exportAsync`. Add `createPrometheusExporter` for the text
exposition format 0.0.4, and an `onDelivered` callback on the webhook
dispatcher. With a store configured, the synchronous `summarize`, `export` and
`timeseries` throw and point to their async counterparts.
