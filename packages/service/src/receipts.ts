import {
  canonicalJson,
  type JsonValue,
  type ReceiptVerifier,
  type SignedReceipt,
  settlementModels,
  signedReceiptSchema,
  stellarNetworks,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { MAX_ARCHIVE_PAGE_SIZE, type ReceiptFilter } from "@vegaforge/tollway-observability";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { tenantOf } from "./auth.js";
import { type ErrorBody, errorBody, errorBodySchema } from "./errors.js";
import type { ServiceLogger } from "./logger.js";
import { defineRoute } from "./routes.js";
import type { ReceiptStore } from "./stores.js";
import { matchesTenantClaim, type TenantScope, tenantClaimFields } from "./tenancy.js";

/**
 * Tenant-scoped receipts routes (#225, #231): ingest canonical signed receipts
 * verified against a configured `ReceiptVerifier`, read one back by id, and
 * search with a tenant- and query-bound pagination cursor.
 */

/** Maximum signed receipts accepted in one `POST /v1/receipts` or `POST /v1/ingest` batch. */
export const MAX_RECEIPT_BATCH = 500;

/** Options passed to {@link receiptsModule}. */
export type ReceiptsModuleOptions = {
  /**
   * Trusted receipt verifier (`Ed25519Verifier`, `EcdsaP256Verifier` or
   * `createKeySetVerifier`). Required to accept writes: the service never
   * archives a receipt it did not verify.
   */
  verifier?: ReceiptVerifier;
};

const flatReceiptWithClaimSchema = signedReceiptSchema.extend(tenantClaimFields);

const wrappedReceiptWithClaimSchema = z.strictObject({
  ...tenantClaimFields,
  receipt: signedReceiptSchema,
});

/** Schema for one receipt item inside an ingest batch (plain, flat-claimed, or wrapped). */
export const receiptIngestItemSchema = z.union([
  flatReceiptWithClaimSchema,
  wrappedReceiptWithClaimSchema,
]);

/** Request body schema for `POST /v1/receipts`. */
export const ingestReceiptsBodySchema = z.strictObject({
  ...tenantClaimFields,
  receipts: z.array(receiptIngestItemSchema).min(1).max(MAX_RECEIPT_BATCH),
});

/** Query schema for `GET /v1/receipts`. */
export const receiptsQuerySchema = z.strictObject({
  payer: z.string().min(1).optional(),
  payee: z.string().min(1).optional(),
  model: z.enum(settlementModels).optional(),
  network: z.enum(stellarNetworks).optional(),
  asset: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  resourcePrefix: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  txHash: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  sequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ARCHIVE_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
});

const receiptIdParams = z.strictObject({ id: z.string().min(1) });

const rejected = { description: "The request was refused.", schema: errorBodySchema };

/** Normalized receipt item after separating optional tenant claims from the signed receipt. */
export type UnwrappedReceiptItem = {
  orgId?: string | undefined;
  projectId?: string | undefined;
  signed: SignedReceipt;
};

/** Separates optional `orgId`/`projectId` claims from a batch receipt item. */
export function unwrapReceiptIngestItem(
  item: z.output<typeof receiptIngestItemSchema>,
): UnwrappedReceiptItem {
  if ("signature" in item) {
    const { orgId, projectId, ...signed } = item;
    return { orgId, projectId, signed };
  }
  return {
    orgId: item.orgId,
    projectId: item.projectId,
    signed: item.receipt,
  };
}

/**
 * Counts how many distinct receipt IDs in `items` are not yet stored in `tenant`,
 * so re-submitting an identical receipt does not consume additional `maxStoredRecords` quota.
 */
export async function countNewReceiptsInBatch(
  store: ReceiptStore,
  tenant: TenantScope,
  items: readonly UnwrappedReceiptItem[],
): Promise<number> {
  const uniqueIds = new Set(items.map((item) => item.signed.receipt.id));
  let netNew = 0;
  for (const id of uniqueIds) {
    const existing = await store.get(tenant, id);
    if (existing === undefined) netNew += 1;
  }
  return netNew;
}

/** Outcome of verifying and storing a batch of receipts all-or-nothing. */
export type ArchiveReceiptsBatchOutcome =
  | { ok: true; stored: number; duplicates: number }
  | { ok: false; status: 400 | 409; body: ErrorBody };

/**
 * Verifies every receipt signature and checks for ID conflicts across both the
 * batch itself and `store` before writing any row, preventing partial writes on
 * validation or conflict errors.
 */
export async function verifyAndStoreReceipts(options: {
  store: ReceiptStore;
  tenant: TenantScope;
  items: readonly UnwrappedReceiptItem[];
  verifier: ReceiptVerifier;
  logger: ServiceLogger;
}): Promise<ArchiveReceiptsBatchOutcome> {
  const { store, tenant, items, verifier, logger } = options;
  const seenInBatch = new Map<string, string>();

  for (const item of items) {
    const verification = await verifyReceipt(item.signed, verifier);
    if (!verification.valid) {
      return {
        ok: false,
        status: 400,
        body: errorBody(
          "invalid-request",
          `receipt "${item.signed.receipt.id}" failed verification: ${verification.reason}`,
        ),
      };
    }

    const id = item.signed.receipt.id;
    const canonical = canonicalJson(item.signed as unknown as JsonValue);
    const batchExisting = seenInBatch.get(id);
    if (batchExisting !== undefined && batchExisting !== canonical) {
      logger.warn("receipt-conflict", {
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        receiptId: id,
      });
      return {
        ok: false,
        status: 409,
        body: errorBody("conflict", `batch carries conflicting bodies for receipt "${id}"`),
      };
    }
    seenInBatch.set(id, canonical);

    const storedExisting = await store.get(tenant, id);
    if (storedExisting !== undefined) {
      const storedCanonical = canonicalJson(storedExisting.receipt as unknown as JsonValue);
      if (storedCanonical !== canonical) {
        logger.warn("receipt-conflict", {
          orgId: tenant.orgId,
          projectId: tenant.projectId,
          receiptId: id,
        });
        return {
          ok: false,
          status: 409,
          body: errorBody("conflict", `receipt "${id}" is already stored with a different body`),
        };
      }
    }
  }

  let stored = 0;
  let duplicates = 0;
  for (const item of items) {
    const outcome = await store.put(tenant, item.signed);
    if (outcome === "conflict") {
      logger.warn("receipt-conflict", {
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        receiptId: item.signed.receipt.id,
      });
      return {
        ok: false,
        status: 409,
        body: errorBody(
          "conflict",
          `receipt "${item.signed.receipt.id}" is already stored with a different body`,
        ),
      };
    }
    if (outcome === "stored") stored += 1;
    else duplicates += 1;
  }
  return { ok: true, stored, duplicates };
}

function receiptFilterFrom(query: z.output<typeof receiptsQuerySchema>): ReceiptFilter {
  const filter: ReceiptFilter = {};
  if (query.payer !== undefined) filter.payer = query.payer;
  if (query.payee !== undefined) filter.payee = query.payee;
  if (query.model !== undefined) filter.model = query.model;
  if (query.network !== undefined) filter.network = query.network;
  if (query.asset !== undefined) filter.asset = query.asset;
  if (query.resource !== undefined) filter.resource = query.resource;
  if (query.resourcePrefix !== undefined) filter.resourcePrefix = query.resourcePrefix;
  if (query.from !== undefined) filter.from = query.from;
  if (query.to !== undefined) filter.to = query.to;
  if (query.txHash !== undefined) filter.txHash = query.txHash;
  if (query.channelId !== undefined) filter.channelId = query.channelId;
  if (query.sequence !== undefined) filter.sequence = query.sequence;
  return filter;
}

/** Builds the tenant-scoped receipts API module (`/v1/receipts` and `/v1/receipts/{id}`). */
export function receiptsModule(options: ReceiptsModuleOptions = {}): ServiceModule {
  const { verifier } = options;

  return ({ stores, cursors, quotas, logger }) => [
    defineRoute({
      method: "post",
      path: "/v1/receipts",
      summary: "Ingest signed receipts",
      description:
        "Verifies and archives a batch of canonical signed receipts inside the calling key's tenant.",
      tags: ["receipts"],
      scope: "ingest",
      request: { body: ingestReceiptsBodySchema },
      responses: {
        202: {
          description: "The batch was verified and archived.",
          schema: z.object({ stored: z.number(), duplicates: z.number() }),
        },
        400: rejected,
        403: rejected,
        409: rejected,
        429: rejected,
        503: rejected,
      },
      handler: async (c, { body }) => {
        const tenant = tenantOf(c);
        const unwrapped = body.receipts.map(unwrapReceiptIngestItem);
        if (
          !matchesTenantClaim(tenant, body) ||
          unwrapped.some((item) => !matchesTenantClaim(tenant, item))
        ) {
          return c.json(
            errorBody(
              "tenant-mismatch",
              "batch items must belong to the authenticated API key's org and project",
            ),
            403,
          );
        }

        if (verifier === undefined) {
          return c.json(
            errorBody("not-ready", "no receipt verifier is configured on this service instance"),
            503,
          );
        }

        const admission = await quotas.acquire(tenant, {
          ingestItems: unwrapped.length,
          newStoredRecords: () => countNewReceiptsInBatch(stores.receipts, tenant, unwrapped),
        });
        if (!admission.allowed) {
          c.header("Retry-After", String(admission.retryAfterSeconds));
          return c.json(admission.body, 429);
        }

        try {
          const outcome = await verifyAndStoreReceipts({
            store: stores.receipts,
            tenant,
            items: unwrapped,
            verifier,
            logger,
          });
          if (!outcome.ok) {
            return c.json(outcome.body, outcome.status);
          }
          return c.json({ stored: outcome.stored, duplicates: outcome.duplicates }, 202);
        } finally {
          admission.release();
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/receipts",
      summary: "List signed receipts",
      description:
        "Searches signed receipts in the calling key's tenant, newest first, paged by a tenant-bound cursor.",
      tags: ["receipts"],
      scope: "read",
      request: { query: receiptsQuerySchema },
      responses: {
        200: {
          description: "One page of receipts.",
          schema: z.object({
            receipts: z.array(signedReceiptSchema),
            nextCursor: z.string().optional(),
          }),
        },
        400: rejected,
      },
      handler: async (c, { query }) => {
        const tenant = tenantOf(c);
        const filterBinding = {
          payer: query.payer ?? null,
          payee: query.payee ?? null,
          model: query.model ?? null,
          network: query.network ?? null,
          asset: query.asset ?? null,
          resource: query.resource ?? null,
          resourcePrefix: query.resourcePrefix ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
          txHash: query.txHash ?? null,
          channelId: query.channelId ?? null,
          sequence: query.sequence ?? null,
        };

        let innerCursor: string | undefined;
        if (query.cursor !== undefined) {
          innerCursor = await cursors.verify(
            tenant,
            "GET /v1/receipts",
            filterBinding,
            query.cursor,
          );
          if (innerCursor === undefined) {
            return c.json(
              errorBody("invalid-request", "cursor is not valid for this tenant and query"),
              400,
            );
          }
        }

        try {
          const result = await stores.receipts.list(tenant, receiptFilterFrom(query), {
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
          });
          const receipts = result.items.map((entry) => entry.receipt);
          if (result.nextCursor === null) return c.json({ receipts });
          const nextCursor = await cursors.sign(
            tenant,
            "GET /v1/receipts",
            filterBinding,
            result.nextCursor,
          );
          return c.json({ receipts, nextCursor });
        } catch (error) {
          if (
            error instanceof TollwayError &&
            (error.code === "invalid-receipt-query" || error.code === "invalid-cursor")
          ) {
            return c.json(errorBody("invalid-request", error.message), 400);
          }
          throw error;
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/receipts/{id}",
      summary: "Read one signed receipt",
      tags: ["receipts"],
      scope: "read",
      request: { params: receiptIdParams },
      responses: {
        200: { description: "The signed receipt.", schema: signedReceiptSchema },
        404: rejected,
      },
      handler: async (c, { params }) => {
        const tenant = tenantOf(c);
        const found = await stores.receipts.get(tenant, params.id);
        if (found === undefined) {
          return c.json(
            errorBody("not-found", `receipt "${params.id}" is not stored for this tenant`),
            404,
          );
        }
        return c.json(found.receipt);
      },
    }),
  ];
}
