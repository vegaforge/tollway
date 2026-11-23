/**
 * @vegaforge/tollway-service
 *
 * An optional shared HTTP service over Tollway telemetry. `createService`
 * returns a Hono app: ingest payment metrics from many gates and clients, and
 * serve spend summaries, bucketed time series and JSON or CSV exports for a
 * dashboard. See apps/web/src/content/docs/service.mdx.
 */

export {
  createService,
  DEFAULT_METRICS_LIMITS,
  type MetricsLimits,
  type ServiceConfig,
} from "./app.js";
export {
  hashApiKey,
  requireScope,
  type ServiceApiKey,
  type ServiceScope,
  serviceScopes,
} from "./auth.js";
export { type ApiErrorBody, apiError } from "./http.js";
export {
  type AssetSummary,
  type ExportQuery,
  exportQuerySchema,
  type IngestBody,
  ingestBodySchema,
  MAX_METRIC_BATCH,
  paymentMetricSchema,
  type SeriesQuery,
  type SeriesResponse,
  type SummaryQuery,
  type SummaryResponse,
  seriesQuerySchema,
  summaryQuerySchema,
  toSummaryResponse,
} from "./metrics.js";
export { openApiDocument } from "./openapi.js";
export { createInMemoryMetricsStore, type MetricsStore } from "./store.js";
