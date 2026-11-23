---
"@vegaforge/tollway-service": minor
"@vegaforge/tollway-observability": minor
---

`@vegaforge/tollway-service` is new: a Hono app with API-key auth (scopes `ingest` and `read`), `POST /v1/metrics`, summary, bucketed time-series and JSON/CSV export routes, request limits and an OpenAPI 3.1 document. `@vegaforge/tollway-observability` now filters metrics by `asset` and `outcome`, counts only settled amounts as spend in `summarize`, reports `byOutcome` and settled per-asset breakdowns by model, payer and payee, and applies the new filters to time series and exports.
