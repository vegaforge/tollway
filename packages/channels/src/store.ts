/**
 * The persistence boundary for tracked channels and their commitment streams.
 *
 * For now the only implementation is in-memory and process-local. The
 * interface is here so the same manager can switch to a durable store
 * (Redis, SQLite, the optional shared service) without changing the manager.
 */

import type { Channel, ChannelListFilter, ChannelPage, Commitment } from "./types.js";

export interface CommitmentStore {
  putChannel(channel: Channel): Promise<void>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  updateChannel(channelId: string, patch: Partial<Channel>): Promise<Channel | undefined>;
  appendCommitment(commitment: Commitment): Promise<void>;
  listCommitments(channelId: string): Promise<readonly Commitment[]>;
  /**
   * Every tracked channel in one status, in no particular order.
   * `resumeAll` uses it to find the channels a crash left in `closing`
   * (#176). It is deliberately narrow: the paged, filtered listing the
   * service endpoints need is `listChannels` (#179, #227).
   */
  listChannelsByStatus(status: Channel["status"]): Promise<readonly Channel[]>;
  /**
   * Every tracked channel, newest first, filtered and paginated. A cursor from
   * one page resumes exactly after the last channel it returned, even when a
   * channel's status changed in between.
   */
  listChannels(filter?: ChannelListFilter): Promise<ChannelPage>;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Newest first, with the id as the tie-break, so paging is deterministic. */
function compareChannels(a: Channel, b: Channel): number {
  if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** The sort key of a channel, encoded so callers cannot depend on its shape. */
function encodeCursor(channel: Channel): string {
  return Buffer.from(JSON.stringify([channel.openedAt, channel.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { openedAt: string; id: string } {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RangeError("cursor is not a channel list cursor");
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 2 ||
    typeof parts[0] !== "string" ||
    typeof parts[1] !== "string"
  ) {
    throw new RangeError("cursor is not a channel list cursor");
  }
  return { openedAt: parts[0], id: parts[1] };
}

/** True when `channel` sorts after the cursor's channel. */
function isAfterCursor(channel: Channel, cursor: { openedAt: string; id: string }): boolean {
  if (channel.openedAt !== cursor.openedAt) return channel.openedAt < cursor.openedAt;
  return channel.id < cursor.id;
}

export function createMemoryCommitmentStore(): CommitmentStore {
  const channels = new Map<string, Channel>();
  const commitments = new Map<string, Commitment[]>();

  return {
    async putChannel(channel) {
      channels.set(channel.id, channel);
      if (!commitments.has(channel.id)) commitments.set(channel.id, []);
    },
    async getChannel(channelId) {
      return channels.get(channelId);
    },
    async updateChannel(channelId, patch) {
      const current = channels.get(channelId);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      channels.set(channelId, next);
      return next;
    },
    async appendCommitment(commitment) {
      const stream = commitments.get(commitment.channelId) ?? [];
      stream.push(commitment);
      commitments.set(commitment.channelId, stream);
    },
    async listCommitments(channelId) {
      const stream = commitments.get(channelId) ?? [];
      return [...stream].sort((a, b) => a.sequence - b.sequence);
    },
    async listChannelsByStatus(status) {
      return [...channels.values()].filter((channel) => channel.status === status);
    },
    async listChannels(filter = {}) {
      const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new RangeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}, got ${limit}`);
      }
      const cursor = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor);
      const matching = [...channels.values()]
        .filter(
          (channel) =>
            (filter.status === undefined || channel.status === filter.status) &&
            (filter.counterparty === undefined || channel.counterparty === filter.counterparty) &&
            (filter.asset === undefined || channel.asset === filter.asset),
        )
        .sort(compareChannels)
        .filter((channel) => cursor === undefined || isAfterCursor(channel, cursor));

      const page = matching.slice(0, limit);
      const last = page.at(-1);
      // One more match than the page means there is another page to fetch.
      return last && matching.length > page.length
        ? { channels: page, nextCursor: encodeCursor(last) }
        : { channels: page };
    },
  };
}
