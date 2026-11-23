---
date: 2026-11-23
feature: Shared metrics API and correct spend summaries
scope: feat
packages: [@vegaforge/tollway-service, @vegaforge/tollway-observability]
scenario-impact: none
---

# Shared metrics API and correct spend summaries

A dashboard can now read Tollway telemetry over HTTP from one place, and the
spend numbers it reads only count money that actually moved.

`@vegaforge/tollway-service` is a new optional package. `createService(config)`
returns a Hono app with `POST /v1/metrics` for batches of `PaymentMetric`,
`GET /v1/metrics/summary`, `GET /v1/metrics/series` for bucketed spend, counts
and latency, and `GET /v1/metrics/export` for JSON or CSV. API keys are stored
as SHA-256 digests, compared without an early return, and scoped `ingest` or
`read`. Filters and buckets are validated at the boundary; a range past the
configured limit, or one that would produce too many buckets or export rows, is
a `400` naming the limit. Every route and schema appears in `/openapi.json`.

The summary rollup in `@vegaforge/tollway-observability` had two defects a
dashboard cannot work with. It summed the amount of failed and skipped metrics
into spend, overstating what was paid, and every breakdown mixed assets into
one number. `summarize` now adds only settled amounts, reports counts per
outcome, and returns settled totals per `(model, asset)`, `(payer, asset)` and
`(payee, asset)` next to the existing per-asset totals. `MetricsQuery` gains
`asset` and `outcome` filters, and `timeseries` and `export` apply them too.

Closes #226.
