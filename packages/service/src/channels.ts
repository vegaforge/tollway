import {
  type Channel,
  ChannelAlreadyClosedError,
  type ChannelManager,
  type Commitment,
} from "@vegaforge/tollway-channels";
import { z } from "zod";
import type { ServiceContext, ServiceModule } from "./app.js";
import { requireTenantKey, tenantOf } from "./auth.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { describeError } from "./logger.js";
import { defineRoute, type ServiceRoute } from "./routes.js";
import { scopedRecordKey, type TenantScope } from "./tenancy.js";

/**
 * The channels API (#227, #231): list the channels tracked for the calling
 * key's `(orgId, projectId)` tenant, read one with its commitment stream, and
 * trigger a close. The service never holds channel funds: they stay in the
 * channel contract, and the close is the same one the funder side would run
 * itself.
 */

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const integerString = z
  .string()
  .regex(/^[0-9]+$/)
  .describe("An integer in the asset's smallest unit, as a string.");

const channelStatuses = [
  "open",
  "closing",
  "closed",
  "recovering",
  "recovered",
  "settlement-mismatched",
] as const satisfies readonly Channel["status"][];

/** Schema describing who asked the service to close a channel, and when. */
export const closeRequestSchema = z.object({
  /** The name of the API key that made the request. Never the key. */
  requestedBy: z.string(),
  requestedAt: z.string(),
});

/** Recorded metadata for an accepted channel close request. */
export type CloseRequest = z.infer<typeof closeRequestSchema>;

/** Response schema for one tracked channel on `/v1/channels` and `/v1/channels/{id}`. */
export const channelViewSchema = z.object({
  id: z.string(),
  counterparty: z.string(),
  asset: z.string(),
  deposit: integerString,
  committed: integerString,
  /** `deposit - committed`, computed as a bigint. */
  remaining: integerString,
  sequence: z.number().int(),
  status: z.enum(channelStatuses),
  network: z.string(),
  openTxHash: z.string(),
  openedAt: z.string(),
  lastCommitAt: z.string().optional(),
  settlementTxHash: z.string().optional(),
  returnedRemainder: integerString.optional(),
  /** What the manager's close policy says about this channel now. */
  shouldClose: z.boolean(),
  /** Set once this process has accepted a close request for the channel. */
  closeRequest: closeRequestSchema.optional(),
  /**
   * The channel's reconciliation status. Reserved: it stays absent until
   * #212 or #213 persists reconcile results.
   */
  reconcileStatus: z.string().optional(),
});

/** Serialized channel view returned by the channels API. */
export type ChannelView = z.infer<typeof channelViewSchema>;

const commitmentViewSchema = z.object({
  channelId: z.string(),
  sequence: z.number().int(),
  cumulativeAmount: integerString,
  /** The funder-signed blob. Present only with `include=blob` and the admin scope. */
  commitment: z.string().optional(),
});

const channelIdParams = z.strictObject({ id: z.string().min(1) });

const pageLimit = z.coerce.number().int().min(1).max(MAX_PAGE).optional();

function parseSequencePayload(payload: string): number | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return undefined;
  }
  return typeof decoded === "number" && Number.isSafeInteger(decoded) && decoded >= 0
    ? decoded
    : undefined;
}

/** Options passed to {@link createChannelsModule}. */
export type ChannelsModuleOptions = {
  /** ISO 8601 clock for close requests. Defaults to `new Date().toISOString()`. */
  now?: () => string;
};

/**
 * Builds the channels module. Mount it with `createService({ channelManagers,
 * modules: [createChannelsModule()] })`; it throws when the service has no
 * `channelManagers`, so a deployment never serves an empty channels API by
 * mistake.
 */
export function createChannelsModule(options: ChannelsModuleOptions = {}): ServiceModule {
  const now = options.now ?? (() => new Date().toISOString());
  return (context) => channelRoutes(context, now);
}

function channelRoutes(context: ServiceContext, now: () => string): readonly ServiceRoute[] {
  const resolveManager = context.channelManagers;
  if (resolveManager === undefined) {
    throw new Error(
      "the channels module needs channelManagers: pass createService({ channelManagers })",
    );
  }
  const { logger, observabilityFor, cursors, stores } = context;
  // Keyed by `(orgId, projectId, channelId)` so two projects sharing one
  // channel id never collide on close metadata or in-flight guards.
  const closeRequests = new Map<string, CloseRequest>();
  const closing = new Map<string, Promise<void>>();

  const view = async (
    tenant: TenantScope,
    manager: ChannelManager,
    channel: Channel,
  ): Promise<ChannelView> => {
    const request = closeRequests.get(scopedRecordKey(tenant, channel.id));
    return {
      id: channel.id,
      counterparty: channel.counterparty,
      asset: channel.asset,
      deposit: channel.deposit,
      committed: channel.committed,
      remaining: (BigInt(channel.deposit) - BigInt(channel.committed)).toString(),
      sequence: channel.sequence,
      status: channel.status,
      network: channel.network,
      openTxHash: channel.openTxHash,
      openedAt: channel.openedAt,
      ...(channel.lastCommitAt === undefined ? {} : { lastCommitAt: channel.lastCommitAt }),
      ...(channel.settlementTxHash === undefined
        ? {}
        : { settlementTxHash: channel.settlementTxHash }),
      ...(channel.returnedRemainder === undefined
        ? {}
        : { returnedRemainder: channel.returnedRemainder }),
      shouldClose: await manager.shouldClose(channel.id),
      ...(request === undefined ? {} : { closeRequest: request }),
    };
  };

  const notFound = (id: string) =>
    errorBody("not-found", `channel "${id}" is not tracked for this tenant`);

  return [
    defineRoute({
      method: "get",
      path: "/v1/channels",
      summary: "List channels",
      description:
        "Every channel tracked for the calling key's tenant, newest first, filtered and paged by a tenant-bound cursor.",
      tags: ["channels"],
      scope: "read",
      request: {
        query: z.strictObject({
          status: z.enum(channelStatuses).optional(),
          counterparty: z.string().min(1).optional(),
          asset: z.string().min(1).optional(),
          cursor: z.string().min(1).optional(),
          limit: pageLimit,
        }),
      },
      responses: {
        200: {
          description: "One page of channels.",
          schema: z.object({
            channels: z.array(channelViewSchema),
            nextCursor: z.string().optional(),
          }),
        },
        400: { description: "A filter or the cursor is invalid.", schema: errorBodySchema },
      },
      handler: async (c, { query }) => {
        const tenant = tenantOf(c);
        const filterBinding = {
          status: query.status ?? null,
          counterparty: query.counterparty ?? null,
          asset: query.asset ?? null,
        };
        let innerCursor: string | undefined;
        if (query.cursor !== undefined) {
          innerCursor = await cursors.verify(
            tenant,
            "GET /v1/channels",
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

        const manager = resolveManager(tenant);
        if (manager === undefined) {
          return c.json({ channels: [] });
        }

        let page: Awaited<ReturnType<ChannelManager["listChannels"]>>;
        try {
          page = await manager.listChannels({
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.counterparty === undefined ? {} : { counterparty: query.counterparty }),
            ...(query.asset === undefined ? {} : { asset: query.asset }),
            ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
            limit: query.limit ?? DEFAULT_PAGE,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            return c.json(errorBody("invalid-request", error.message), 400);
          }
          throw error;
        }
        const channels = await Promise.all(
          page.channels.map((channel) => view(tenant, manager, channel)),
        );
        if (page.nextCursor === undefined) return c.json({ channels });
        const nextCursor = await cursors.sign(
          tenant,
          "GET /v1/channels",
          filterBinding,
          page.nextCursor,
        );
        return c.json({ channels, nextCursor });
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/channels/{id}",
      summary: "Read a channel",
      tags: ["channels"],
      scope: "read",
      request: { params: channelIdParams },
      responses: {
        200: { description: "The channel.", schema: channelViewSchema },
        404: {
          description: "No tracked channel has this id in this tenant.",
          schema: errorBodySchema,
        },
      },
      handler: async (c, { params }) => {
        const tenant = tenantOf(c);
        const manager = resolveManager(tenant);
        if (manager === undefined) return c.json(notFound(params.id), 404);
        const channel = await manager.get(params.id);
        if (channel === undefined) return c.json(notFound(params.id), 404);
        return c.json(await view(tenant, manager, channel));
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/channels/{id}/commitments",
      summary: "Read a channel's commitment stream",
      description:
        "Commitments ordered by sequence, paged by a tenant-bound cursor. The signed blob is left out unless include=blob is passed with the admin scope.",
      tags: ["channels"],
      scope: "read",
      request: {
        params: channelIdParams,
        query: z.strictObject({
          include: z.enum(["blob"]).optional(),
          cursor: z.string().min(1).optional(),
          limit: pageLimit,
        }),
      },
      responses: {
        200: {
          description: "One page of commitments.",
          schema: z.object({
            commitments: z.array(commitmentViewSchema),
            nextCursor: z.string().optional(),
          }),
        },
        400: { description: "The cursor is invalid.", schema: errorBodySchema },
        403: {
          description: "include=blob was asked for without the admin scope.",
          schema: errorBodySchema,
        },
        404: {
          description: "No tracked channel has this id in this tenant.",
          schema: errorBodySchema,
        },
      },
      handler: async (c, { params, query }) => {
        const key = requireTenantKey(c);
        const tenant = tenantOf(c);
        const withBlob = query.include === "blob";
        if (withBlob && !key.scopes.includes("admin")) {
          return c.json(
            errorBody("forbidden", "include=blob needs an API key with the admin scope"),
            403,
          );
        }

        const cursorBinding = { id: params.id, include: query.include ?? null };
        let after = -1;
        if (query.cursor !== undefined) {
          const payload = await cursors.verify(
            tenant,
            "GET /v1/channels/{id}/commitments",
            cursorBinding,
            query.cursor,
          );
          const decoded = payload === undefined ? undefined : parseSequencePayload(payload);
          if (decoded === undefined) {
            return c.json(
              errorBody("invalid-request", "cursor is not valid for this tenant and query"),
              400,
            );
          }
          after = decoded;
        }

        const manager = resolveManager(tenant);
        if (manager === undefined) return c.json(notFound(params.id), 404);
        const channel = await manager.get(params.id);
        if (channel === undefined) return c.json(notFound(params.id), 404);

        const limit = query.limit ?? DEFAULT_PAGE;
        const remaining = (await manager.list(params.id)).filter(
          (commitment) => commitment.sequence > after,
        );
        const page = remaining.slice(0, limit);
        const commitments = page.map((commitment: Commitment) => ({
          channelId: commitment.channelId,
          sequence: commitment.sequence,
          cumulativeAmount: commitment.cumulativeAmount,
          ...(withBlob ? { commitment: commitment.commitment } : {}),
        }));
        const last = page.at(-1);
        if (last === undefined || remaining.length <= page.length) {
          return c.json({ commitments });
        }
        const nextCursor = await cursors.sign(
          tenant,
          "GET /v1/channels/{id}/commitments",
          cursorBinding,
          JSON.stringify(last.sequence),
        );
        return c.json({ commitments, nextCursor });
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/channels/{id}/close",
      summary: "Close a channel",
      description:
        "Asks the tenant's channel manager to settle the channel on chain with its latest commitment. Idempotent: a channel already closing or closed is returned as it is, and never closed twice. The service holds no channel funds.",
      tags: ["channels"],
      scope: "admin",
      request: { params: channelIdParams },
      responses: {
        200: {
          description: "The channel after the close, or as it already was.",
          schema: channelViewSchema,
        },
        404: {
          description: "No tracked channel has this id in this tenant.",
          schema: errorBodySchema,
        },
        409: {
          description: "The channel is in a state a close cannot start from, such as recovering.",
          schema: errorBodySchema,
        },
        502: {
          description: "The close failed. The channel's current status is in details.",
          schema: errorBodySchema,
        },
      },
      handler: async (c, { params }) => {
        const key = requireTenantKey(c);
        const tenant = tenantOf(c);
        const manager = resolveManager(tenant);
        const id = params.id;
        if (manager === undefined) return c.json(notFound(id), 404);
        const channel = await manager.get(id);
        if (channel === undefined) return c.json(notFound(id), 404);

        if (channel.status === "closing" || channel.status === "closed") {
          return c.json(await view(tenant, manager, channel));
        }
        if (channel.status !== "open") {
          return c.json(
            errorBody("conflict", `channel "${id}" is ${channel.status}; it cannot be closed`, {
              status: channel.status,
            }),
            409,
          );
        }

        const lockKey = scopedRecordKey(tenant, id);
        let run = closing.get(lockKey);
        if (run === undefined) {
          const request: CloseRequest = { requestedBy: key.name, requestedAt: now() };
          run = closeOnce(tenant, manager, id, request).finally(() => closing.delete(lockKey));
          closing.set(lockKey, run);
        }
        try {
          await run;
        } catch (error) {
          const current = await manager.get(id);
          logger.error("channel-close-failed", {
            orgId: tenant.orgId,
            projectId: tenant.projectId,
            channelId: id,
            ...describeError(error),
          });
          return c.json(
            errorBody("close-failed", `the close of channel "${id}" did not complete`, {
              status: current?.status ?? null,
            }),
            502,
          );
        }
        const closed = await manager.get(id);
        if (closed === undefined) return c.json(notFound(id), 404);
        return c.json(await view(tenant, manager, closed));
      },
    }),
  ];

  async function closeOnce(
    tenant: TenantScope,
    channelManager: ChannelManager,
    id: string,
    request: CloseRequest,
  ): Promise<void> {
    logger.info("channel-close-requested", {
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      channelId: id,
      requestedBy: request.requestedBy,
    });
    let result: Awaited<ReturnType<ChannelManager["close"]>>;
    try {
      result = await channelManager.close(id);
    } catch (error) {
      if (error instanceof ChannelAlreadyClosedError) return;
      throw error;
    }
    closeRequests.set(scopedRecordKey(tenant, id), request);
    await stores.audit.append(tenant, {
      action: "channel.closed",
      actorKey: request.requestedBy,
      resourceId: id,
      createdAt: request.requestedAt,
    });
    const sink = observabilityFor(tenant);
    if (sink !== undefined) {
      await sink.emit({
        type: "channel.closed",
        at: now(),
        data: {
          orgId: tenant.orgId,
          projectId: tenant.projectId,
          channelId: result.channelId,
          settlementTxHash: result.settlementTxHash,
          returnedRemainder: result.returnedRemainder,
          requestedBy: request.requestedBy,
          requestedAt: request.requestedAt,
        },
      });
    }
  }
}
