/**
 * @vegaforge/tollway-service
 *
 * The optional, self-hosted Tollway service: a multi-tenant Hono app with
 * typed configuration, tenant-bound API-key authentication, health and
 * readiness endpoints, per-tenant quotas, and an OpenAPI document generated
 * from the same zod schemas that validate each request. See
 * apps/web/src/content/docs/service.mdx.
 *
 * This entry imports nothing Node-only. The `tollway-service` binary adds the
 * Node listener and config-file loading.
 */

export { adminModule, tenantSummarySchema } from "./admin.js";
export {
  type CreateServiceOptions,
  createService,
  type ObservabilitySink,
  type ObservabilitySource,
  SERVICE_API_VERSION,
  type ServiceContext,
  type ServiceModule,
} from "./app.js";
export {
  type AuthenticatedKey,
  type AuthenticatedOperator,
  hashApiKey,
  type RouteScope,
  requireTenantKey,
  tenantOf,
} from "./auth.js";
export {
  type ChannelsModuleOptions,
  type ChannelView,
  type CloseRequest,
  channelViewSchema,
  closeRequestSchema,
  createChannelsModule,
} from "./channels.js";
export {
  type ApiKeyConfig,
  type ApiKeyScope,
  apiKeyConfigSchema,
  apiKeyScopes,
  type ConfigIssue,
  type ConfigSources,
  type OperatorKeyConfig,
  operatorKeyConfigSchema,
  parseServiceConfig,
  type QuotasConfig,
  quotasConfigSchema,
  SERVICE_CONFIG_FILE_ENV,
  SERVICE_ENV,
  type ServiceConfig,
  ServiceConfigError,
  serviceConfigSchema,
  type TenantQuota,
  type TenantQuotaOverride,
  tenantQuotaOverrideSchema,
  tenantQuotaSchema,
} from "./config.js";
export {
  type ErrorBody,
  errorBody,
  errorBodySchema,
  type ServiceErrorCode,
  serviceErrorCodes,
} from "./errors.js";
export {
  type BatchIngestResponse,
  batchIngestBodySchema,
  batchIngestResponseSchema,
  type IngestModuleOptions,
  ingestEventItemSchema,
  ingestModule,
  MAX_EVENT_BATCH,
} from "./ingest.js";
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
export {
  auditEntrySchema,
  auditQuerySchema,
  diffPolicyValues,
  policiesModule,
  policyVersionResponseSchema,
  putPolicyBodySchema,
} from "./policies.js";
export {
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryClient,
  type PostgresSessionSource,
  type ServicePostgresSchemaOptions,
  serviceTenantMigrations,
  withOperatorReadTransaction,
  withTenantTransaction,
} from "./postgres-rls.js";
export {
  type CreateQuotaEnforcerOptions,
  createQuotaEnforcer,
  type QuotaCheckOutcome,
  type QuotaEnforcer,
  type QuotaRequest,
} from "./quotas.js";
export { type ReadinessReport, readinessReportSchema } from "./readiness.js";
export {
  type ArchiveReceiptsBatchOutcome,
  countNewReceiptsInBatch,
  ingestReceiptsBodySchema,
  MAX_RECEIPT_BATCH,
  type ReceiptsModuleOptions,
  receiptIngestItemSchema,
  receiptsModule,
  receiptsQuerySchema,
  type UnwrappedReceiptItem,
  unwrapReceiptIngestItem,
  verifyAndStoreReceipts,
} from "./receipts.js";
export {
  type AnyObjectSchema,
  defineRoute,
  type HttpMethod,
  type RouteDefinition,
  type RouteInput,
  type RouteOutput,
  type RouteResponse,
  type ServiceRoute,
} from "./routes.js";
export {
  type AdminStore,
  type AuditDiffEntry,
  type AuditEntry,
  type AuditEntryInput,
  type AuditListFilter,
  type AuditPage,
  type AuditPageOptions,
  type AuditStore,
  bindTenantChannelStore,
  type ChannelStore,
  createMemoryAdminStore,
  createMemoryAuditStore,
  createMemoryChannelStore,
  createMemoryMetricsStore,
  createMemoryPolicyStore,
  createMemoryReceiptStore,
  createMemoryStores,
  createMemoryStoresWithAdmin,
  createTenantChannelManagers,
  type MetricsStore,
  type PolicyStore,
  type PolicyVersion,
  type ReceiptPutResult,
  type ReceiptStore,
  type ScopedChannel,
  type ScopedChannelPage,
  type ScopedCommitment,
  type ServiceStore,
  type ServiceStores,
  type StoredReceipt,
  type StoredReceiptPage,
  type TenantChannelManagersOptions,
  type TenantSummary,
} from "./stores.js";
export {
  type CursorCodec,
  constantTimeEqual,
  createCursorCodec,
  matchesTenantClaim,
  scopedRecordKey,
  type TenantClaim,
  type TenantScope,
  tenantClaimFields,
  tenantIdSchema,
  tenantPartitionKey,
  tenantScopeSchema,
} from "./tenancy.js";
export type { ServiceEnv } from "./types.js";
