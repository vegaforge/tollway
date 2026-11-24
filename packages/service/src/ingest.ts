import { canonicalJson, type JsonValue, type ReceiptVerifier } from "@vegaforge/tollway-core";
import { type PaymentMetric, webhookEvents } from "@vegaforge/tollway-observability";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { tenantOf } from "./auth.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { MAX_METRIC_BATCH, paymentMetricSchema } from "./metrics.js";
import {
  countNewReceiptsInBatch,
  MAX_RECEIPT_BATCH,
  receiptIngestItemSchema,
  unwrapReceiptIngestItem,
  verifyAndStoreReceipts,
} from "./receipts.js";
import { defineRoute } from "./routes.js";
import { matchesTenantClaim, tenantClaimFields, tenantPartitionKey } from "./tenancy.js";

/**
 * Multi-item batch ingest route (#229, #231): receives buffered receipts,
 * metrics and lifecycle events from gates and clients, verifies that every
 * item belongs to the calling key's `(orgId, projectId)` before writing a
 * single row, deduplicates retries by a tenant-scoped idempotency key bound to
 * the batch payload, and enforces per-tenant quotas.
 */

/** Maximum lifecycle events accepted in one `POST /v1/ingest` batch. */
export const MAX_EVENT_BATCH = 500;
const MAX_IDEMPOTENCY_KEYS_PER_TENANT = 1_000;
const MAX_IDEMPOTENCY_TENANTS = 1_000;

/** Options passed to {@link ingestModule}. */
export type IngestModuleOptions = {
  /** Trusted receipt verifier required whenever a batch carries receipts. */
  verifier?: ReceiptVerifier;
};

/** Schema for one lifecycle event item inside `POST /v1/ingest`. */
export const ingestEventItemSchema = z.strictObject({
  id: z.string().min(1).max(128).optional(),
  type: z.enum(webhookEvents),
  at: z.iso.datetime({ offset: true }),
  ...tenantClaimFields,
  data: z.record(z.string(), z.unknown()),
});

/** Request body schema for `POST /v1/ingest`. */
export const batchIngestBodySchema = z
  .strictObject({
    ...tenantClaimFields,
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/, "expected 1 to 128 safe idempotency characters")
      .optional(),
    receipts: z.array(receiptIngestItemSchema).max(MAX_RECEIPT_BATCH).optional(),
    metrics: z.array(paymentMetricSchema).max(MAX_METRIC_BATCH).optional(),
    events: z.array(ingestEventItemSchema).max(MAX_EVENT_BATCH).optional(),
  })
  .refine(
    (body) =>
      (body.receipts?.length ?? 0) + (body.metrics?.length ?? 0) + (body.events?.length ?? 0) > 0,
    "batch must include at least one receipt, metric or event",
  );

/** Response schema returned by `POST /v1/ingest`. */
export const batchIngestResponseSchema = z.object({
  deduplicated: z.boolean(),
  receipts: z.object({ stored: z.number(), duplicates: z.number() }),
  metrics: z.object({ accepted: z.number() }),
  events: z.object({ emitted: z.number() }),
});

/** Serialized response body returned by `POST /v1/ingest`. */
export type BatchIngestResponse = z.infer<typeof batchIngestResponseSchema>;

type CachedBatch = {
  fingerprint: string;
  response: BatchIngestResponse;
};

const rejected = { description: "The request was refused.", schema: errorBodySchema };

/** Builds the tenant-scoped batch ingest API module (`POST /v1/ingest`). */
export function ingestModule(options: IngestModuleOptions = {}): ServiceModule {
  const { verifier } = options;

  return ({ stores, quotas, observabilityFor, logger }) => {
    const seenBatches = new Map<string, Map<string, CachedBatch>>();

    const lookupBatch = (partitionKey: string, idempotencyKey: string): CachedBatch | undefined =>
      seenBatches.get(partitionKey)?.get(idempotencyKey);

    const rememberBatch = (
      partitionKey: string,
      idempotencyKey: string,
      entry: CachedBatch,
    ): void => {
      let bucket = seenBatches.get(partitionKey);
      if (bucket === undefined) {
        if (seenBatches.size >= MAX_IDEMPOTENCY_TENANTS) {
          const oldestTenant = seenBatches.keys().next().value;
          if (oldestTenant !== undefined) seenBatches.delete(oldestTenant);
        }
        bucket = new Map();
        seenBatches.set(partitionKey, bucket);
      }
      if (!bucket.has(idempotencyKey) && bucket.size >= MAX_IDEMPOTENCY_KEYS_PER_TENANT) {
        const oldestKey = bucket.keys().next().value;
        if (oldestKey !== undefined) bucket.delete(oldestKey);
      }
      bucket.set(idempotencyKey, entry);
    };

    return [
      defineRoute({
        method: "post",
        path: "/v1/ingest",
        summary: "Ingest a batch of receipts, metrics and events",
        description:
          "Validates tenant ownership across every item in the batch, enforces per-tenant quotas, deduplicates retries by idempotencyKey, and stores each item under the calling key's tenant.",
        tags: ["ingest"],
        scope: "ingest",
        request: { body: batchIngestBodySchema },
        responses: {
          202: { description: "The batch was processed.", schema: batchIngestResponseSchema },
          400: rejected,
          403: rejected,
          409: rejected,
          429: rejected,
          503: rejected,
        },
        handler: async (c, { body }) => {
          const tenant = tenantOf(c);
          const receipts = (body.receipts ?? []).map(unwrapReceiptIngestItem);
          const metrics = body.metrics ?? [];
          const events = body.events ?? [];

          // Reject the whole batch before dedupe, signature verification or
          // writes whenever the envelope or any item claims another tenant.
          const claimMismatch =
            !matchesTenantClaim(tenant, body) ||
            receipts.some((item) => !matchesTenantClaim(tenant, item)) ||
            metrics.some((item) => !matchesTenantClaim(tenant, item)) ||
            events.some((item) => !matchesTenantClaim(tenant, item)) ||
            events.some(
              (item) =>
                (Object.hasOwn(item.data, "orgId") && item.data.orgId !== tenant.orgId) ||
                (Object.hasOwn(item.data, "projectId") && item.data.projectId !== tenant.projectId),
            );
          if (claimMismatch) {
            return c.json(
              errorBody(
                "tenant-mismatch",
                "batch items must belong to the authenticated API key's org and project",
              ),
              403,
            );
          }

          if (receipts.length > 0 && verifier === undefined) {
            return c.json(
              errorBody("not-ready", "no receipt verifier is configured on this service instance"),
              503,
            );
          }

          const cleanMetrics: PaymentMetric[] = metrics.map(
            ({ orgId: _o, projectId: _p, ...metric }) => metric,
          );
          const partitionKey = tenantPartitionKey(tenant);
          const idempotencyKey = body.idempotencyKey;
          const batchFingerprint =
            idempotencyKey === undefined
              ? undefined
              : canonicalJson({
                  receipts: receipts.map((item) => item.signed),
                  metrics: cleanMetrics,
                  events: events.map(({ orgId: _o, projectId: _p, ...event }) => event),
                } as unknown as JsonValue);

          const totalItems = receipts.length + metrics.length + events.length;
          // Rate limits always apply; idempotent replays charge 0 newStoredRecords
          // and run inside the per-tenant gate so concurrent retries never double-write.
          const admission = await quotas.acquire(tenant, {
            ingestItems: totalItems,
            newStoredRecords: async () => {
              if (
                idempotencyKey !== undefined &&
                lookupBatch(partitionKey, idempotencyKey) !== undefined
              ) {
                return 0;
              }
              const newReceipts = await countNewReceiptsInBatch(stores.receipts, tenant, receipts);
              return newReceipts + cleanMetrics.length;
            },
          });
          if (!admission.allowed) {
            c.header("Retry-After", String(admission.retryAfterSeconds));
            return c.json(admission.body, 429);
          }

          try {
            if (idempotencyKey !== undefined && batchFingerprint !== undefined) {
              const cached = lookupBatch(partitionKey, idempotencyKey);
              if (cached !== undefined) {
                if (cached.fingerprint !== batchFingerprint) {
                  return c.json(
                    errorBody(
                      "conflict",
                      `idempotencyKey "${idempotencyKey}" was already used with a different batch payload`,
                    ),
                    409,
                  );
                }
                return c.json({ ...cached.response, deduplicated: true }, 202);
              }
            }

            let stored = 0;
            let duplicates = 0;
            if (receipts.length > 0 && verifier !== undefined) {
              const outcome = await verifyAndStoreReceipts({
                store: stores.receipts,
                tenant,
                items: receipts,
                verifier,
                logger,
              });
              if (!outcome.ok) {
                return c.json(outcome.body, outcome.status);
              }
              stored = outcome.stored;
              duplicates = outcome.duplicates;
            }

            if (cleanMetrics.length > 0) {
              await stores.metrics.record(tenant, cleanMetrics);
            }

            const sink = observabilityFor(tenant);
            if (sink !== undefined) {
              for (const event of events) {
                await sink.emit({
                  ...(event.id === undefined ? {} : { id: event.id }),
                  type: event.type,
                  at: event.at,
                  data: {
                    ...event.data,
                    orgId: tenant.orgId,
                    projectId: tenant.projectId,
                  },
                });
              }
            }

            const result: BatchIngestResponse = {
              deduplicated: false,
              receipts: { stored, duplicates },
              metrics: { accepted: cleanMetrics.length },
              events: { emitted: sink === undefined ? 0 : events.length },
            };
            if (idempotencyKey !== undefined && batchFingerprint !== undefined) {
              rememberBatch(partitionKey, idempotencyKey, {
                fingerprint: batchFingerprint,
                response: result,
              });
            }
            return c.json(result, 202);
          } finally {
            admission.release();
          }
        },
      }),
    ];
  };
}
