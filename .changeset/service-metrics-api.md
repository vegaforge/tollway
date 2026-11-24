---
"@vegaforge/tollway-service": minor
"@vegaforge/tollway-observability": minor
---

`@vegaforge/tollway-service` gains `metricsModule()`, which adds `POST /v1/metrics`, `GET /v1/metrics/summary`, `GET /v1/metrics/series` and `GET /v1/metrics/export`, with request limits and OpenAPI entries generated from their schemas. The `tollway-service` binary mounts it. `MetricsStore` gains `timeseries` and `export`, which a custom store must now implement.

`@vegaforge/tollway-observability`: `summarize` now adds only settled amounts and reports `byOutcome` and settled breakdowns per model, payer and payee in each asset. `MetricsQuery` gains `asset` and `outcome` filters, which `timeseries` and `export` apply too. The deprecated cross-asset fields keep their shape, but they now count settled amounts only.
