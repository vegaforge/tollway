/**
 * @vegaforge/tollway-service
 *
 * The optional, self-hosted Tollway service: a Hono app with typed
 * configuration, API-key authentication, health and readiness endpoints, and
 * an OpenAPI document generated from the same zod schemas that validate each
 * request. Later issues mount their routes on it as modules. See
 * apps/web/src/content/docs/service.mdx.
 *
 * This entry imports nothing Node-only. The `tollway-service` binary adds the
 * Node listener and config-file loading.
 */

export {
  type CreateServiceOptions,
  createService,
  SERVICE_API_VERSION,
  type ServiceContext,
  type ServiceModule,
} from "./app.js";
export { type AuthenticatedKey, hashApiKey } from "./auth.js";
export {
  type ChannelsModuleOptions,
  type ChannelView,
  type CloseRequest,
  createChannelsModule,
} from "./channels.js";
export {
  type ApiKeyConfig,
  type ApiKeyScope,
  apiKeyConfigSchema,
  apiKeyScopes,
  type ConfigIssue,
  type ConfigSources,
  parseServiceConfig,
  SERVICE_CONFIG_FILE_ENV,
  SERVICE_ENV,
  type ServiceConfig,
  ServiceConfigError,
  serviceConfigSchema,
} from "./config.js";
export {
  type ErrorBody,
  errorBody,
  errorBodySchema,
  type ServiceErrorCode,
  serviceErrorCodes,
} from "./errors.js";
export {
  createConsoleLogger,
  type LogFields,
  type ServiceLogger,
} from "./logger.js";
export {
  DEFAULT_METRICS_LIMITS,
  exportQuerySchema,
  ingestBodySchema,
  MAX_METRIC_BATCH,
  type MetricsLimits,
  type MetricsModuleOptions,
  metricsErrorCodes,
  metricsModule,
  paymentMetricSchema,
  type SummaryResponse,
  seriesQuerySchema,
  seriesResponseSchema,
  summaryQuerySchema,
  summaryResponseSchema,
  toSummaryResponse,
} from "./metrics.js";
export { buildOpenApiDocument, type OpenApiDocument } from "./openapi.js";
export { type ReadinessReport, readinessReportSchema } from "./readiness.js";
export {
  defineRoute,
  type HttpMethod,
  type RouteDefinition,
  type RouteInput,
  type RouteResponse,
  type ServiceRoute,
} from "./routes.js";
export {
  type ChannelStore,
  createMemoryChannelStore,
  createMemoryMetricsStore,
  createMemoryPolicyStore,
  createMemoryReceiptStore,
  createMemoryStores,
  type MetricsStore,
  type PolicyStore,
  type PolicyVersion,
  type ReceiptPutResult,
  type ReceiptStore,
  type ServiceStore,
  type ServiceStores,
} from "./stores.js";
export type { ServiceEnv } from "./types.js";
