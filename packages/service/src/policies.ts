import { formatPolicyIssues, parsePolicy, policySchema } from "@vegaforge/tollway-core";
import { z } from "zod";
import type { ServiceContext, ServiceModule } from "./app.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { defineRoute, type ServiceRoute } from "./routes.js";
import { InvalidAuditCursorError, type PolicyVersion } from "./stores.js";

/**
 * The versioned policy store API (#228): create, read, update and retire
 * per-agent policies with optimistic concurrency (`ETag` / `If-Match`),
 * conditional reads (`If-None-Match` -> `304`), and an immutable audit log.
 *
 * Enforcement still happens in the agent process via `createPolicyEngine`;
 * the service only validates, versions, stores and serves policy documents.
 */

const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Opaque operator-chosen agent identifier, bounded in length and URL-safe. */
export const agentIdSchema = z
  .string()
  .regex(AGENT_ID_PATTERN, "agentId must be 1 to 128 characters of A-Za-z0-9._:-");

const agentParamsSchema = z.object({
  agentId: agentIdSchema,
});

const agentVersionParamsSchema = z.object({
  agentId: agentIdSchema,
  version: z.coerce.number().int().min(1),
});

/** JSON representation of one immutable policy version (or tombstone when `retired` is true). */
export const policyVersionViewSchema = z.object({
  agentId: z.string(),
  version: z.number().int().min(1),
  retired: z.boolean(),
  policy: policySchema.nullable(),
  createdAt: z.string(),
});

export type PolicyVersionView = z.infer<typeof policyVersionViewSchema>;

const policyVersionsListSchema = z.object({
  agentId: z.string(),
  versions: z.array(policyVersionViewSchema),
});

const policyDiffEntrySchema = z.object({
  path: z.string(),
  op: z.enum(["add", "remove", "replace"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

const policyAuditEntrySchema = z.object({
  sequence: z.number().int().min(1),
  agentId: z.string(),
  version: z.number().int().min(1),
  action: z.enum(["create", "update", "retire"]),
  actor: z.string(),
  createdAt: z.string(),
  diff: z.array(policyDiffEntrySchema),
});

const policyAuditPageSchema = z.object({
  entries: z.array(policyAuditEntrySchema),
  nextCursor: z.string().optional(),
});

const auditQuerySchema = z.strictObject({
  agentId: agentIdSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function toPolicyVersionView(entry: PolicyVersion): PolicyVersionView {
  return {
    agentId: entry.agentId,
    version: entry.version,
    retired: entry.policy === null,
    policy: entry.policy,
    createdAt: entry.createdAt,
  };
}

function formatEtag(version: number): string {
  return `"${version}"`;
}

function parseSingleEtagVersion(token: string): number | undefined {
  const match = /^(?:W\/)?(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/.exec(token.trim());
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) return undefined;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function ifNoneMatchMatches(headerValue: string | undefined, version: number): boolean {
  if (headerValue === undefined) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  return trimmed.split(",").some((candidate) => parseSingleEtagVersion(candidate) === version);
}

/**
 * Mounts the policy CRUD and audit trail routes on `/v1/agents/{agentId}/policy`
 * and `/v1/audit`.
 */
export function policyModule(): ServiceModule {
  return (context) => policyRoutes(context);
}

function policyRoutes(context: ServiceContext): readonly ServiceRoute[] {
  const { policies } = context.stores;

  return [
    defineRoute({
      method: "put",
      path: "/v1/agents/{agentId}/policy",
      summary: "Create or update an agent policy",
      description:
        "Validates the policy document with @vegaforge/tollway-core, checks If-Match for optimistic concurrency, appends a new immutable version, and writes an audit record.",
      tags: ["policies"],
      scope: "admin",
      request: {
        params: agentParamsSchema,
        body: z
          .unknown()
          .describe("Policy document validated by @vegaforge/tollway-core parsePolicy."),
      },
      responses: {
        200: { description: "Policy updated to a new version.", schema: policyVersionViewSchema },
        201: { description: "Initial policy version created.", schema: policyVersionViewSchema },
        412: {
          description: "If-Match header missing or did not match the current version.",
          schema: errorBodySchema,
        },
        422: {
          description: "Policy failed schema validation; details.issues lists the failing paths.",
          schema: errorBodySchema,
        },
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

        const current = await policies.current(params.agentId);
        const ifMatch = c.req.header("if-match");
        let expectedVersion: number | null;

        if (current === undefined) {
          if (ifMatch !== undefined && ifMatch.trim() !== "*") {
            return c.json(
              errorBody("precondition-failed", "no policy exists yet for this agent"),
              412,
            );
          }
          expectedVersion = null;
        } else {
          if (ifMatch === undefined) {
            return c.json(
              errorBody(
                "precondition-failed",
                "If-Match header with the current version is required",
                { currentVersion: current.version },
              ),
              412,
            );
          }
          const matchedVersion = parseSingleEtagVersion(ifMatch);
          if (matchedVersion !== current.version) {
            return c.json(
              errorBody("precondition-failed", "If-Match does not match current policy version", {
                currentVersion: current.version,
              }),
              412,
            );
          }
          expectedVersion = current.version;
        }

        const actor = c.get("apiKey").name;
        const stored = await policies.append(params.agentId, parsed.policy, expectedVersion, actor);
        if (stored === "version-conflict") {
          return c.json(errorBody("precondition-failed", "policy was modified concurrently"), 412);
        }

        c.header("ETag", formatEtag(stored.version));
        return c.json(toPolicyVersionView(stored), stored.version === 1 ? 201 : 200);
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy",
      summary: "Get current agent policy",
      description:
        "Returns the active policy for the agent with an ETag header, or 304 when If-None-Match matches.",
      tags: ["policies"],
      scope: "read",
      request: { params: agentParamsSchema },
      responses: {
        200: { description: "Current active policy.", schema: policyVersionViewSchema },
        304: { description: "Cached policy matches the current ETag." },
        404: { description: "No active policy exists for this agent.", schema: errorBodySchema },
      },
      handler: async (c, { params }) => {
        const current = await policies.current(params.agentId);
        if (current === undefined || current.policy === null) {
          return c.json(
            errorBody("not-found", `no active policy for agent "${params.agentId}"`),
            404,
          );
        }

        const etag = formatEtag(current.version);
        c.header("ETag", etag);
        if (ifNoneMatchMatches(c.req.header("if-none-match"), current.version)) {
          return c.body(null, 304);
        }
        return c.json(toPolicyVersionView(current), 200);
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy/versions",
      summary: "List agent policy versions",
      description:
        "Lists all immutable policy versions for the agent in ascending version order, including retired tombstones.",
      tags: ["policies"],
      scope: "read",
      request: { params: agentParamsSchema },
      responses: {
        200: {
          description: "All stored versions for the agent.",
          schema: policyVersionsListSchema,
        },
      },
      handler: async (c, { params }) => {
        const list = await policies.versions(params.agentId);
        return c.json(
          {
            agentId: params.agentId,
            versions: list.map(toPolicyVersionView),
          },
          200,
        );
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/agents/{agentId}/policy/versions/{version}",
      summary: "Get a specific agent policy version",
      description: "Returns a single immutable policy version (active or retired) by number.",
      tags: ["policies"],
      scope: "read",
      request: { params: agentVersionParamsSchema },
      responses: {
        200: { description: "The requested policy version.", schema: policyVersionViewSchema },
        404: { description: "Policy version not found.", schema: errorBodySchema },
      },
      handler: async (c, { params }) => {
        const found = await policies.getVersion(params.agentId, params.version);
        if (found === undefined) {
          return c.json(
            errorBody(
              "not-found",
              `policy version ${params.version} not found for agent "${params.agentId}"`,
            ),
            404,
          );
        }
        c.header("ETag", formatEtag(found.version));
        return c.json(toPolicyVersionView(found), 200);
      },
    }),

    defineRoute({
      method: "delete",
      path: "/v1/agents/{agentId}/policy",
      summary: "Retire an agent policy",
      description:
        "Appends a retired tombstone version without deleting history, and records the retirement in the audit trail.",
      tags: ["policies"],
      scope: "admin",
      request: { params: agentParamsSchema },
      responses: {
        200: {
          description: "Policy retired via tombstone version.",
          schema: policyVersionViewSchema,
        },
        404: { description: "No active policy exists to retire.", schema: errorBodySchema },
        412: {
          description: "If-Match header did not match the current version.",
          schema: errorBodySchema,
        },
      },
      handler: async (c, { params }) => {
        const current = await policies.current(params.agentId);
        if (current === undefined || current.policy === null) {
          return c.json(
            errorBody("not-found", `no active policy for agent "${params.agentId}"`),
            404,
          );
        }

        const ifMatch = c.req.header("if-match");
        if (ifMatch !== undefined && ifMatch.trim() !== "*") {
          const matchedVersion = parseSingleEtagVersion(ifMatch);
          if (matchedVersion !== current.version) {
            return c.json(
              errorBody("precondition-failed", "If-Match does not match current policy version", {
                currentVersion: current.version,
              }),
              412,
            );
          }
        }

        const actor = c.get("apiKey").name;
        const retired = await policies.append(params.agentId, null, current.version, actor);
        if (retired === "version-conflict") {
          return c.json(errorBody("precondition-failed", "policy was modified concurrently"), 412);
        }

        c.header("ETag", formatEtag(retired.version));
        return c.json(toPolicyVersionView(retired), 200);
      },
    }),

    defineRoute({
      method: "get",
      path: "/v1/audit",
      summary: "List policy audit records",
      description:
        "Lists immutable audit records (newest first) with optional agentId filtering and cursor pagination.",
      tags: ["policies", "audit"],
      scope: "read",
      request: { query: auditQuerySchema },
      responses: {
        200: { description: "One page of audit records.", schema: policyAuditPageSchema },
      },
      handler: async (c, { query }) => {
        try {
          const page = await policies.listAudit({
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          });
          return c.json(page, 200);
        } catch (error) {
          if (error instanceof InvalidAuditCursorError) {
            return c.json(errorBody("invalid-request", error.message), 400);
          }
          throw error;
        }
      },
    }),
  ];
}
