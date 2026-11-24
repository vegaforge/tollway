---
date: 2026-11-23
feature: Metrics API on the shared service, and spend summaries that count only settled money
scope: feat
packages: [@vegaforge/tollway-service, @vegaforge/tollway-observability]
scenario-impact: none
---

# Metrics API and correct spend summaries

A dashboard can now read Tollway telemetry over HTTP from one place, and the
spend it reads counts only money that actually moved.

`@vegaforge/tollway-service` gains `metricsModule()`, mounted by the
`tollway-service` binary:

- `POST /v1/metrics` (scope `ingest`) records batches of up to 1000
  `PaymentMetric` values, each validated field by field.
- `GET /v1/metrics/summary` (scope `read`) returns settled spend per asset,
  broken down by model, payer and payee, with counts per outcome. It has no
  cross-asset total.
- `GET /v1/metrics/series` returns spend, counts and latency percentiles per
  time bucket, per asset, optionally split by payer or payee.
- `GET /v1/metrics/export` returns the matched metrics as a JSON or CSV
  download.

Every route goes through the service's `MetricsStore`, which gains `timeseries`
and `export`. The counting rules stay the observability hub's. A range wider than
`maxRangeMs`, a series with too many buckets and an export with too many rows
are each refused with a `400` that names the limit. Every route appears in
`/openapi.json` from the same schemas that validate it.

`summarize` in `@vegaforge/tollway-observability` had two defects a dashboard
cannot work with. It added failed and skipped metrics to spend, and every
breakdown mixed assets. It now adds only settled amounts, reports counts per
outcome, and returns settled totals per model, payer and payee in each asset.
`MetricsQuery` gains `asset` and `outcome` filters, and `timeseries` and
`export` apply them too.

Closes #226. Pull request: #321.
