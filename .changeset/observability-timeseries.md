---
"@vegaforge/tollway-observability": minor
---

Add `hub.timeseries({ from, to, bucket, groupBy? })`: UTC-aligned, half-open, contiguous `1m` / `5m` / `1h` / `1d` buckets with one row per model and asset (optionally per payee or payer), carrying the settled amount as an integer string, settled / failed / skipped counts, and nearest-rank p50 / p95 / p99 latency. Oversized ranges throw `MetricsQueryTooLargeError` (limits `maxTimeseriesBuckets`, default 10080, and `maxTimeseriesRows`, default 200000). Fix `summarize` adding amounts across assets: it now returns `byAsset`, and `totalAmount`, `byModel`, `byPayer` and `byPayee` are deprecated.
