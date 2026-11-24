---
date: 2026-11-24
feature: Persistent metrics storage, Prometheus exporter, duplicate settlement detection, and OpenTelemetry instrumentation
scope: feat
packages: ["@vegaforge/tollway-observability"]
scenario-impact: none
---

# Observability: Persistent Metrics Storage and Prometheus Export

Three new capabilities for production observability:

**Persistent metrics storage** (#217): Payment metrics can now be stored durably in SQLite or Postgres instead of only in memory. The `MetricsStore` interface accepts custom backends; this release includes `createSqliteMetricsStore` for immediate use. Metrics survive process restarts and can be queried, filtered, and purged with configurable retention.

**Prometheus /metrics exporter** (#218): The `formatPrometheusMetrics` function exports payment metrics as Prometheus text format, with machine-readable metric names documented in `TOLLWAY_METRIC_NAMES`. Includes settlement counts and amounts by model, outcome, and asset; latency percentiles (p50, p95, p99); and per-payer and per-payee spend. The `createPrometheusHandler` wraps it as Express/Fastify middleware for immediate `/metrics` endpoint deployment.

**Duplicate settlement detection** (#216): The `createDuplicateDetector` tracks settlement nonces and commitment sequences across a configurable time window, with TTL and capacity limits, to prevent double-settlement within a process. For cross-process detection, pair with a persistent backend like Redis or the metrics store.

**OpenTelemetry instrumentation** (#219): The `createOtelSpan`, `traceSettlementOperation`, and `extractOtelContextFromHeaders` functions add W3C Trace Context support. Spans capture settlement model, payer, payee, latency, and errors for distributed tracing. The `createOtelMetricsCollector` records settlement and error metrics in OpenMetrics format.

All are opt-in and do not affect existing code that uses `createObservabilityHub` without these features.
