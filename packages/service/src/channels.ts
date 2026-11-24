import {
  type Channel,
  ChannelAlreadyClosedError,
  type ChannelManager,
  type Commitment,
} from "@vegaforge/tollway-channels";
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "@vegaforge/tollway-core";
import { z } from "zod";
import type { ServiceContext, ServiceModule } from "./app.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { describeError } from "./logger.js";
import { defineRoute, type ServiceRoute } from "./routes.js";

/**
 * The channels API (#227): list the channels this deployment's
 * `ChannelManager` tracks, read one with its commitment stream, and trigger a
 * close. The service never holds channel funds: they stay in the channel
 * contract, and the close is the same one the funder side would run itself.
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

/** Who asked the service to close a channel, and when. */
const closeRequestSchema = z.object({
  /** The name of the API key that made the request. Never the key. */
  requestedBy: z.string(),
  requestedAt: z.string(),
});

export type CloseRequest = z.infer<typeof closeRequestSchema>;

const channelViewSchema = z.object({
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

export type ChannelView = z.infer<typeof channelViewSchema>;

const commitmentViewSchema = z.object({
  channelId: z.string(),
  sequence: z.number().int(),
  cumulativeAmount: integerString,
  /** The funder-signed blob. Present only with `include=blob` and the admin scope. */
  commitment: z.string().optional(),
});

const channelIdParams = z.object({ id: z.string().min(1) });

const pageLimit = z.coerce.number().int().min(1).max(MAX_PAGE).optional();

/** Decodes a commitment cursor: the sequence of the last commitment returned. */
function decodeSequenceCursor(cursor: string): number | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(cursor)));
  } catch {
    return undefined;
  }
  return Number.isSafeInteger(decoded) ? (decoded as number) : undefined;
}

function encodeSequenceCursor(sequence: number): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify(sequence)));
}

export type ChannelsModuleOptions = {
  /** ISO 8601 clock for close requests. Defaults to `new Date().toISOString()`. */
  now?: () => string;
};

/**
 * Builds the channels module. Mount it with `createService({ channelManager,
 * modules: [createChannelsModule()] })`; it throws when the service has no
 * `channelManager`, so a deployment never serves an empty channels API by
 * mistake.
 *
 * Concurrent close requests for one channel in this process share a single
 * close, so the adapter submits once. Across replicas that needs the store's
 * compare-and-set (#175); until then, run one replica with the admin scope.
 */
export function createChannelsModule(options: ChannelsModuleOptions = {}): ServiceModule {
  const now = options.now ?? (() => new Date().toISOString());
  return (context) => channelRoutes(context, now);
}

function channelRoutes(context: ServiceContext, now: () => string): readonly ServiceRoute[] {
  const manager = context.channelManager;
  if (manager === undefined) {
    throw new Error(
      "the channels module needs a channelManager: pass createService({ channelManager })",
    );
  }
  const { logger, observability } = context;
  // Accepted close requests, kept for the life of the process. The close
  // itself is recorded by the manager's store; this records who asked.
  const closeRequests = new Map<string, CloseRequest>();
  // One close in flight per channel. The map is read and written with no
  // await in between, so two requests cannot both start a close.
  const closing = new Map<string, Promise<void>>();

  const view = async (channel: Channel): Promise<ChannelView> => {
    const request = closeRequests.get(channel.id);
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
    errorBody("not-found", `channel "${id}" is not tracked by this service`);

  return [
    defineRoute({
      method: "get",
      path: "/v1/channels",
      summary: "List channels",
      description:
        "Every channel this deployment's channel manager tracks, newest first, filtered and paged by cursor.",
      tags: ["channels"],
      scope: "read",
      request: {
        query: z.object({
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
        let page: Awaited<ReturnType<ChannelManager["listChannels"]>>;
        try {
          page = await manager.listChannels({
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.counterparty === undefined ? {} : { counterparty: query.counterparty }),
            ...(query.asset === undefined ? {} : { asset: query.asset }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: query.limit ?? DEFAULT_PAGE,
          });
        } catch (error) {
          // The store rejects a cursor it did not issue with a RangeError.
          if (error instanceof RangeError) {
            return c.json(errorBody("invalid-request", error.message), 400);
          }
          throw error;
        }
        const channels = await Promise.all(page.channels.map(view));
        return c.json(
          page.nextCursor === undefined ? { channels } : { channels, nextCursor: page.nextCursor },
        );
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
        404: { description: "No tracked channel has this id.", schema: errorBodySchema },
      },
      handler: async (c, { params }) => {
        const channel = await manager.get(params.id);
        if (channel === undefined) return c.json(notFound(params.id), 404);
        return c.json(await view(channel));
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/channels/{id}/commitments",
      summary: "Read a channel's commitment stream",
      description:
        "Commitments ordered by sequence, paged by cursor. The signed blob is left out unless include=blob is passed with the admin scope.",
      tags: ["channels"],
      scope: "read",
      request: {
        params: channelIdParams,
        query: z.object({
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
        404: { description: "No tracked channel has this id.", schema: errorBodySchema },
      },
      handler: async (c, { params, query }) => {
        const withBlob = query.include === "blob";
        if (withBlob && !c.get("apiKey").scopes.includes("admin")) {
          return c.json(
            errorBody("forbidden", "include=blob needs an API key with the admin scope"),
            403,
          );
        }
        const channel = await manager.get(params.id);
        if (channel === undefined) return c.json(notFound(params.id), 404);

        let after = -1;
        if (query.cursor !== undefined) {
          const decoded = decodeSequenceCursor(query.cursor);
          if (decoded === undefined) {
            return c.json(errorBody("invalid-request", "cursor is not a commitment cursor"), 400);
          }
          after = decoded;
        }
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
        return c.json(
          last !== undefined && remaining.length > page.length
            ? { commitments, nextCursor: encodeSequenceCursor(last.sequence) }
            : { commitments },
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/v1/channels/{id}/close",
      summary: "Close a channel",
      description:
        "Asks the channel manager to settle the channel on chain with its latest commitment. Idempotent: a channel already closing or closed is returned as it is, and never closed twice. The service holds no channel funds.",
      tags: ["channels"],
      scope: "admin",
      request: { params: channelIdParams },
      responses: {
        200: {
          description: "The channel after the close, or as it already was.",
          schema: channelViewSchema,
        },
        404: { description: "No tracked channel has this id.", schema: errorBodySchema },
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
        const id = params.id;
        const channel = await manager.get(id);
        if (channel === undefined) return c.json(notFound(id), 404);

        if (channel.status === "closing" || channel.status === "closed") {
          return c.json(await view(channel));
        }
        if (channel.status !== "open") {
          return c.json(
            errorBody("conflict", `channel "${id}" is ${channel.status}; it cannot be closed`, {
              status: channel.status,
            }),
            409,
          );
        }

        let run = closing.get(id);
        if (run === undefined) {
          const request: CloseRequest = { requestedBy: c.get("apiKey").name, requestedAt: now() };
          run = closeOnce(manager, id, request).finally(() => closing.delete(id));
          closing.set(id, run);
        }
        try {
          await run;
        } catch (error) {
          const current = await manager.get(id);
          logger.error("channel-close-failed", { channelId: id, ...describeError(error) });
          return c.json(
            errorBody("close-failed", `the close of channel "${id}" did not complete`, {
              status: current?.status ?? null,
            }),
            502,
          );
        }
        const closed = await manager.get(id);
        if (closed === undefined) return c.json(notFound(id), 404);
        return c.json(await view(closed));
      },
    }),
  ];

  async function closeOnce(
    channelManager: ChannelManager,
    id: string,
    request: CloseRequest,
  ): Promise<void> {
    logger.info("channel-close-requested", { channelId: id, requestedBy: request.requestedBy });
    let result: Awaited<ReturnType<ChannelManager["close"]>>;
    try {
      result = await channelManager.close(id);
    } catch (error) {
      // Another process closed it between our read and our close. Its close
      // stands; this request has nothing left to do.
      if (error instanceof ChannelAlreadyClosedError) return;
      throw error;
    }
    closeRequests.set(id, request);
    if (observability !== undefined) {
      // emit never rejects; its report lists any webhook that failed.
      await observability.emit({
        type: "channel.closed",
        at: now(),
        data: {
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
