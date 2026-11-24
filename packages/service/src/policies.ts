import { policySchema } from "@vegaforge/tollway-core";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { requireTenantKey, tenantOf } from "./auth.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { defineRoute } from "./routes.js";
import type { AuditDiffEntry } from "./stores.js";
import { tenantIdSchema } from "./tenancy.js";

/**
 * Tenant-scoped policy and audit routes (#228, #231): store immutable policy
 * versions per `(orgId, projectId, agentId)` using `@vegaforge/tollway-core`'s
 * `policySchema`, and query the append-only tenant audit log with a signed
 * cursor.
 */

const MAX_AUDIT_PAGE = 200;

const agentIdParams = z.strictObject({ agentId: tenantIdSchema });

/** Request body schema for `PUT /v1/agents/{agentId}/policy`. */
export const putPolicyBodySchema = z.strictObject({
  /** Next policy document, or `null` to retire the agent's policy. */
  policy: policySchema.nullable(),
  /** Optimistic concurrency guard: current version number, or `null` when creating version 1. */
  expectedVersion: z.number().int().min(1).nullable().optional(),
});

/** Response schema for one stored `PolicyVersion`. */
export const policyVersionResponseSchema = z.object({
  orgId: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  version: z.number().int().min(1),
  policy: policySchema.nullable(),
  createdAt: z.string(),
});

/** Response schema for one tenant-scoped `AuditEntry`. */
export const auditEntrySchema = z.object({
  orgId: z.string(),
  projectId: z.string(),
  id: z.string(),
  action: z.string(),
  actorKey: z.string(),
  agentId: z.string().optional(),
  resourceId: z.string().optional(),
  version: z.number().int().optional(),
  changes: z
    .array(
      z.object({
        path: z.string(),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    )
    .optional(),
  createdAt: z.string(),
});

/** Query schema for `GET /v1/audit`. */
export const auditQuerySchema = z.strictObject({
  agentId: tenantIdSchema.optional(),
  action: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE).optional(),
  cursor: z.string().min(1).optional(),
});

const rejected = { description: "The request was refused.", schema: errorBodySchema };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic structural diff between two policy values. */
export function diffPolicyValues(
  before: unknown,
  after: unknown,
  prefix = "",
): readonly AuditDiffEntry[] {
  if (Object.is(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const entries: AuditDiffEntry[] = [];
    for (const key of keys) {
      const nextPath = prefix === "" ? key : `${prefix}.${key}`;
      entries.push(...diffPolicyValues(before[key], after[key], nextPath));
    }
    return entries;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [
    {
      path: prefix === "" ? "$" : prefix,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  ];
}

/** Builds the tenant-scoped policies and audit API module. */
export function policiesModule(): ServiceModule {
  return ({ stores, cursors, quotas }) => [
    defineRoute({
      method: "put",
      path: "/v1/agents/{agentId}/policy",
      summary: "Create or update an agent's policy",
      description:
        "Appends an immutable policy version for `(orgId, projectId, agentId)` when `expectedVersion` matches the current version, and writes an audit entry.",
      tags: ["policies"],
      scope: "admin",
      request: {
        params: agentIdParams,
        body: putPolicyBodySchema,
      },
      responses: {
        200: { description: "The stored policy version.", schema: policyVersionResponseSchema },
        400: rejected,
        409: rejected,
        429: rejected,
      },
      handler: async (c, { params, body }) => {
        const key = requireTenantKey(c);
        const tenant = tenantOf(c);
        // Each accepted update stores one policy version plus one audit entry.
        const admission = await quotas.acquire(tenant, { newStoredRecords: 2 });
        if (!admission.allowed) {
          c.header("Retry-After", String(admission.retryAfterSeconds));
          return c.json(admission.body, 429);
        }

        try {
          const previous = await stores.policies.current(tenant, params.agentId);
          const created = await stores.policies.append(
            tenant,
            params.agentId,
            body.policy,
            body.expectedVersion ?? null,
          );
          if (created === "version-conflict") {
            return c.json(
              errorBody(
                "conflict",
                `policy for agent "${params.agentId}" does not match expectedVersion ${String(body.expectedVersion ?? null)}`,
              ),
              409,
            );
          }

          const changes = diffPolicyValues(previous?.policy ?? null, body.policy);
          await stores.audit.append(tenant, {
            action: body.policy === null ? "policy.retired" : "policy.updated",
            actorKey: key.name,
            agentId: params.agentId,
            version: created.version,
            changes,
            createdAt: created.createdAt,
          });
          c.header("ETag", `"v${created.version}"`);
          return c.json(created);
        } finally {
          admission.release();
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy",
      summary: "Read an agent's current policy",
      tags: ["policies"],
      scope: "read",
      request: { params: agentIdParams },
      responses: {
        200: { description: "The current policy version.", schema: policyVersionResponseSchema },
        404: rejected,
      },
      handler: async (c, { params }) => {
        const tenant = tenantOf(c);
        const current = await stores.policies.current(tenant, params.agentId);
        if (current === undefined) {
          return c.json(
            errorBody("not-found", `no policy is stored for agent "${params.agentId}"`),
            404,
          );
        }
        c.header("ETag", `"v${current.version}"`);
        return c.json(current);
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy/versions",
      summary: "List an agent's policy versions",
      tags: ["policies"],
      scope: "read",
      request: { params: agentIdParams },
      responses: {
        200: {
          description: "Every immutable policy version for the agent.",
          schema: z.object({ versions: z.array(policyVersionResponseSchema) }),
        },
        404: rejected,
      },
      handler: async (c, { params }) => {
        const tenant = tenantOf(c);
        const versions = await stores.policies.versions(tenant, params.agentId);
        if (versions.length === 0) {
          return c.json(
            errorBody("not-found", `no policy is stored for agent "${params.agentId}"`),
            404,
          );
        }
        return c.json({ versions });
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/audit",
      summary: "List tenant audit entries",
      description:
        "Audit entries for the calling key's tenant, newest first, paged by a tenant-bound cursor.",
      tags: ["audit"],
      scope: "read",
      request: { query: auditQuerySchema },
      responses: {
        200: {
          description: "One page of audit entries.",
          schema: z.object({
            entries: z.array(auditEntrySchema),
            nextCursor: z.string().optional(),
          }),
        },
        400: rejected,
      },
      handler: async (c, { query }) => {
        const tenant = tenantOf(c);
        const filterBinding = {
          agentId: query.agentId ?? null,
          action: query.action ?? null,
        };
        let innerCursor: string | undefined;
        if (query.cursor !== undefined) {
          innerCursor = await cursors.verify(tenant, "GET /v1/audit", filterBinding, query.cursor);
          if (innerCursor === undefined) {
            return c.json(
              errorBody("invalid-request", "cursor is not valid for this tenant and query"),
              400,
            );
          }
        }

        const page = await stores.audit.list(
          tenant,
          {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            ...(query.action === undefined ? {} : { action: query.action }),
          },
          {
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
          },
        );
        if (page.nextCursor === undefined) return c.json({ entries: page.entries });
        const nextCursor = await cursors.sign(
          tenant,
          "GET /v1/audit",
          filterBinding,
          page.nextCursor,
        );
        return c.json({ entries: page.entries, nextCursor });
      },
    }),
  ];
}
