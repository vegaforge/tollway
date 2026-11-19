---
date: 2026-11-19
feature: time-series rollups with spend, outcome counts and latency percentiles per model, and per-asset amounts in summarize
scope: feat
packages: ["@vegaforge/tollway-observability", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Time-series rollups and per-asset spend

`hub.timeseries({ from, to, bucket, groupBy? })` on the observability hub
cuts a time range into `1m`, `5m`, `1h` or `1d` buckets and returns, per
bucket, one row per model and asset (optionally split by payee or payer).
Each row carries the settled amount as an integer string, the settled,
failed and skipped counts, and p50, p95 and p99 latency. This is the data
behind the dashboard's "spend over time" and "latency per model" widgets;
wiring them is #232.

`summarize` gains `byAsset`, the amount per asset. It fixes a defect:
`totalAmount` and `byModel` added amounts in different assets together, so a
window with USDC and XLM reported a sum in mixed units. `totalAmount`,
`byModel`, `byPayer` and `byPayee` keep their values and are marked
deprecated.

Technical shape. Buckets are aligned to UTC from epoch milliseconds,
half-open `[start, end)`, and contiguous: every bucket in the range is
returned, and every group seen in the range has a row in every bucket, with
zero counts and `latencyMs: null` where it had no metrics. Amounts are summed
per asset with `bigint`, from `settled` metrics only. Percentiles use the
nearest-rank method on the exact samples. Timestamps go through a strict ISO
8601 parser that requires a zone. A query that would exceed
`maxTimeseriesBuckets` (default 10080) or `maxTimeseriesRows` (default
200000) throws `MetricsQueryTooLargeError` before the result is allocated.
`@vegaforge/tollway-core` gains the error codes `invalid-metrics-query`,
`invalid-metric` and `metrics-query-too-large`. The docs site has a new
Observability page that documents the query and the percentile method.

Choices the issue left open, each taken conservatively:

- `from` and `to` are required, so the bucket count is known and bounded
  before any metric is read. `to` is exclusive, unlike `summarize`.
- `groupBy` is a single value: `"model"` (default), `"payee"` or `"payer"`.
  Model and asset are always part of the key.
- Empty buckets carry one zero row per group seen in the range, so each
  group is a contiguous series; with no metrics at all, buckets have no rows.
- Latency samples come from every outcome, so slow failures stay visible.
  Amounts come from `settled` only.
- Bad recorded data in range (unparseable `at`, a non-integer settled
  amount, a negative or non-finite latency) throws `invalid-metric` instead
  of being skipped.
- A second limit on rows (buckets times groups) guards memory, since the
  bucket limit alone does not bound a dense grid.
- `byAsset` covers the same metrics as `totalAmount` (every outcome), so
  for a one-asset window the two agree. Settled-only amounts are in
  `timeseries`.
- The issue's SQL pushdown criterion depends on the #217 store, which does
  not exist in `packages/observability` yet. The docs record how it will
  apply: bucketing and counts in `GROUP BY`, percentiles exact in SQL where a
  nearest-rank aggregate exists (PostgreSQL `percentile_disc`), otherwise
  computed in process from fetched samples (SQLite).
- Property tests use a small seeded generator instead of adding
  `fast-check` to this package, so no `package.json` or lockfile changes.

Issue #223.
