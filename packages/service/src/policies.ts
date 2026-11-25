import {
  formatPolicyIssues,
  type Policy,
  parsePolicy,
  policySchema,
} from "@vegaforge/tollway-core";
import type { Context } from "hono";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { requireTenantKey, tenantOf } from "./auth.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { defineRoute } from "./routes.js";
import type { AuditDiffEntry, PolicyVersion, ServiceStores } from "./stores.js";
import { type TenantScope, tenantIdSchema } from "./tenancy.js";
import type { ServiceEnv } from "./types.js";

/**
 * Tenant-scoped policy store and audit routes (#228, #231).
 *
 * Each `(orgId, projectId, agentId)` has an append-only list of immutable
 * policy versions. A write names the version it expects with `If-Match`, and
 * the store appends only when that is still the latest version
 * (compare-and-set), so a concurrent edit is refused with 412 instead of
 * overwritten. Every accepted change appends one entry to the tenant's audit
 * log. The service stores and serves policy documents; enforcement still
 * happens in the agent process through `createPolicyEngine`.
 */

const MAX_AUDIT_PAGE = 200;

const agentIdParams = z.strictObject({ agentId: tenantIdSchema });

const agentVersionParams = z.strictObject({
  agentId: tenantIdSchema,
  version: z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/, "expected a positive integer version")
    .transform(Number),
});

/** Response schema for one stored `PolicyVersion`. `policy` is `null` for a retirement tombstone. */
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

/** The `ETag` for a policy version. Versions are per agent, so the tag is too. */
export function policyEtag(version: number): string {
  return `"v${version}"`;
}

const STRONG_ETAG = /^"v([1-9][0-9]{0,8})"$/;
const ANY_ETAG = /^(?:W\/)?"v([1-9][0-9]{0,8})"$/;

/**
 * `If-Match` uses the strong comparison (RFC 9110, section 13.1.1), and this
 * service accepts only a single tag naming the version the caller read.
 * `*` and lists are refused: a write must say which version it replaces, or
 * the compare-and-set guards nothing.
 */
function ifMatchVersion(header: string | undefined): number | undefined {
  const match = header === undefined ? null : STRONG_ETAG.exec(header.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** `If-None-Match` uses the weak comparison and may be `*` or a list (RFC 9110, section 13.1.2). */
function ifNoneMatchHits(header: string | undefined, version: number): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => {
    const match = ANY_ETAG.exec(tag.trim());
    return match?.[1] !== undefined && Number(match[1]) === version;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic structural diff between two policy values: one entry per
 * changed leaf, keyed by a dot-separated path, in sorted key order. `$` is
 * the whole document, used when a policy is created or retired.
 */
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

function preconditionFailed(c: Context<ServiceEnv>, message: string, current?: PolicyVersion) {
  return c.json(
    errorBody(
      "precondition-failed",
      message,
      current === undefined ? undefined : { currentVersion: current.version },
    ),
    412,
  );
}

function noActivePolicy(c: Context<ServiceEnv>, agentId: string) {
  return c.json(errorBody("not-found", `no active policy for agent "${agentId}"`), 404);
}

/**
 * Appends `next` (a policy, or `null` to retire) after `current` and writes
 * the matching audit entry. The caller holds the tenant's quota gate, which
 * serialises writes within the tenant, and the store's compare-and-set still
 * refuses a version that moved underneath.
 */
async function appendWithAudit(
  stores: ServiceStores,
  tenant: TenantScope,
  actorKey: string,
  agentId: string,
  current: PolicyVersion | undefined,
  next: Policy | null,
): Promise<PolicyVersion | "version-conflict"> {
  const stored = await stores.policies.append(tenant, agentId, next, current?.version ?? null);
  if (stored === "version-conflict") return stored;

  const previousPolicy = current?.policy ?? null;
  const action =
    next === null
      ? "policy.retired"
      : previousPolicy === null
        ? "policy.created"
        : "policy.updated";
  await stores.audit.append(tenant, {
    action,
    actorKey,
    agentId,
    version: stored.version,
    changes: diffPolicyValues(previousPolicy, next),
    createdAt: stored.createdAt,
  });
  return stored;
}

/** Builds the tenant-scoped policies and audit API module. */
export function policiesModule(): ServiceModule {
  return ({ stores, cursors, quotas }) => [
    defineRoute({
      method: "put",
      path: "/v1/agents/{agentId}/policy",
      summary: "Create or update an agent's policy",
      description:
        "The body is a policy document, validated with `parsePolicy` from @vegaforge/tollway-core. Creating the first version takes no `If-Match`. Every later change, including one after a retirement, must send `If-Match` with the current version's `ETag`; a missing or stale tag is a 412 and nothing is written. Each accepted change appends an immutable version and an audit entry.",
      tags: ["policies"],
      scope: "admin",
      request: {
        params: agentIdParams,
        body: z.unknown().describe("A policy document (see `Policy` in @vegaforge/tollway-core)."),
      },
      responses: {
        200: { description: "The stored policy version.", schema: policyVersionResponseSchema },
        400: rejected,
        412: rejected,
        422: {
          description: "The policy failed validation. `details.issues` lists each failing path.",
          schema: errorBodySchema,
        },
        429: rejected,
      },
      handler: async (c, { params, body }) => {
        const parsed = parsePolicy(body);
        if (!parsed.ok) {
          return c.json(
            errorBody("invalid-policy", formatPolicyIssues(parsed.issues), {
              issues: parsed.issues,
            }),
            422,
          );
        }

        const key = requireTenantKey(c);
        const tenant = tenantOf(c);
        // Each accepted change stores one policy version plus one audit entry.
        const admission = await quotas.acquire(tenant, { newStoredRecords: 2 });
        if (!admission.allowed) {
          c.header("Retry-After", String(admission.retryAfterSeconds));
          return c.json(admission.body, 429);
        }

        try {
          const current = await stores.policies.current(tenant, params.agentId);
          const ifMatch = c.req.header("If-Match");
          if (current === undefined) {
            if (ifMatch !== undefined) {
              return preconditionFailed(c, `agent "${params.agentId}" has no policy to match`);
            }
          } else if (ifMatchVersion(ifMatch) !== current.version) {
            return preconditionFailed(
              c,
              ifMatch === undefined
                ? `If-Match with the current version is required to change agent "${params.agentId}"`
                : `If-Match does not name the current version of agent "${params.agentId}"`,
              current,
            );
          }

          const stored = await appendWithAudit(
            stores,
            tenant,
            key.name,
            params.agentId,
            current,
            parsed.policy,
          );
          if (stored === "version-conflict") {
            return preconditionFailed(c, `agent "${params.agentId}" was changed concurrently`);
          }
          c.header("ETag", policyEtag(stored.version));
          return c.json(stored);
        } finally {
          admission.release();
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy",
      summary: "Read an agent's active policy",
      description:
        "Returns the latest version with its `ETag`, or 304 with no body when `If-None-Match` names it. A retired policy is a 404; its history stays under `/versions`.",
      tags: ["policies"],
      scope: "read",
      request: { params: agentIdParams },
      responses: {
        200: { description: "The active policy version.", schema: policyVersionResponseSchema },
        304: { description: "`If-None-Match` names the active version." },
        404: rejected,
      },
      handler: async (c, { params }) => {
        const current = await stores.policies.current(tenantOf(c), params.agentId);
        if (current === undefined || current.policy === null) {
          return noActivePolicy(c, params.agentId);
        }
        c.header("ETag", policyEtag(current.version));
        if (ifNoneMatchHits(c.req.header("If-None-Match"), current.version)) {
          return c.body(null, 304);
        }
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
          description: "Every immutable policy version for the agent, oldest first.",
          schema: z.object({ versions: z.array(policyVersionResponseSchema) }),
        },
        404: rejected,
      },
      handler: async (c, { params }) => {
        const versions = await stores.policies.versions(tenantOf(c), params.agentId);
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
      path: "/v1/agents/{agentId}/policy/versions/{version}",
      summary: "Read one policy version",
      description: "Returns one immutable version, including a retirement tombstone.",
      tags: ["policies"],
      scope: "read",
      request: { params: agentVersionParams },
      responses: {
        200: { description: "The requested version.", schema: policyVersionResponseSchema },
        400: rejected,
        404: rejected,
      },
      handler: async (c, { params }) => {
        const found = await stores.policies.getVersion(tenantOf(c), params.agentId, params.version);
        if (found === undefined) {
          return c.json(
            errorBody(
              "not-found",
              `agent "${params.agentId}" has no policy version ${String(params.version)}`,
            ),
            404,
          );
        }
        c.header("ETag", policyEtag(found.version));
        return c.json(found);
      },
    }),
    defineRoute({
      method: "delete",
      path: "/v1/agents/{agentId}/policy",
      summary: "Retire an agent's policy",
      description:
        "Appends a tombstone version (`policy: null`) and an audit entry. History is never deleted. Requires `If-Match` with the active version's `ETag`.",
      tags: ["policies"],
      scope: "admin",
      request: { params: agentIdParams },
      responses: {
        200: { description: "The tombstone version.", schema: policyVersionResponseSchema },
        404: rejected,
        412: rejected,
        429: rejected,
      },
      handler: async (c, { params }) => {
        const key = requireTenantKey(c);
        const tenant = tenantOf(c);
        const admission = await quotas.acquire(tenant, { newStoredRecords: 2 });
        if (!admission.allowed) {
          c.header("Retry-After", String(admission.retryAfterSeconds));
          return c.json(admission.body, 429);
        }

        try {
          const current = await stores.policies.current(tenant, params.agentId);
          if (current === undefined || current.policy === null) {
            return noActivePolicy(c, params.agentId);
          }
          if (ifMatchVersion(c.req.header("If-Match")) !== current.version) {
            return preconditionFailed(
              c,
              `If-Match with the current version is required to retire agent "${params.agentId}"`,
              current,
            );
          }

          const stored = await appendWithAudit(
            stores,
            tenant,
            key.name,
            params.agentId,
            current,
            null,
          );
          if (stored === "version-conflict") {
            return preconditionFailed(c, `agent "${params.agentId}" was changed concurrently`);
          }
          c.header("ETag", policyEtag(stored.version));
          return c.json(stored);
        } finally {
          admission.release();
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/audit",
      summary: "List tenant audit entries",
      description:
        "Audit entries for the calling key's tenant, newest first, paged by a tenant-bound cursor. Entries are append-only: no route edits or deletes them.",
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
