/**
 * The filter, order and page rules for `CommitmentStore.listChannels` (#179,
 * #227). Every store uses these, so the memory, PostgreSQL and Redis stores
 * answer the same query with the same pages. The conformance suite checks
 * that they do.
 *
 * Order: `openedAt` descending, then channel id descending, both compared by
 * UTF-16 code unit. The cursor encodes the sort key of the last channel on
 * a page, so the next page resumes exactly after it even when a channel's
 * status changed in between.
 */

import type { Channel, ChannelListFilter, ChannelPage } from "./types.js";

export const DEFAULT_CHANNEL_PAGE_LIMIT = 50;
export const MAX_CHANNEL_PAGE_LIMIT = 200;

/** The sort key a cursor carries. */
export type ChannelCursor = { openedAt: string; id: string };

/**
 * Checks the page size. A size outside 1 to 200 is a caller error and throws
 * `RangeError`, which the service maps to a 400, rather than a silent clamp.
 */
export function parseChannelPageLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_CHANNEL_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHANNEL_PAGE_LIMIT) {
    throw new RangeError(
      `limit must be an integer from 1 to ${MAX_CHANNEL_PAGE_LIMIT}, got ${String(value)}`,
    );
  }
  return value;
}

/** The sort key of a channel, encoded so callers cannot depend on its shape. */
export function encodeChannelCursor(channel: Pick<Channel, "openedAt" | "id">): string {
  return Buffer.from(JSON.stringify([channel.openedAt, channel.id]), "utf8").toString("base64url");
}

/** Decodes a cursor this module issued. Anything else throws `RangeError`. */
export function decodeChannelCursor(cursor: string): ChannelCursor {
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

/** Newest first, with the id as the tie-break, so paging is deterministic. */
export function compareChannels(a: Channel, b: Channel): number {
  if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** True when `channel` sorts after the cursor's channel. */
export function isAfterCursor(channel: Channel, cursor: ChannelCursor): boolean {
  if (channel.openedAt !== cursor.openedAt) return channel.openedAt < cursor.openedAt;
  return channel.id < cursor.id;
}

/** True when the channel satisfies every filter field that is set. */
export function channelMatches(channel: Channel, filter: ChannelListFilter): boolean {
  if (filter.status !== undefined && channel.status !== filter.status) return false;
  if (filter.counterparty !== undefined && channel.counterparty !== filter.counterparty) {
    return false;
  }
  if (filter.asset !== undefined && channel.asset !== filter.asset) return false;
  if (filter.network !== undefined && channel.network !== filter.network) return false;
  return true;
}

/**
 * Builds one page from an ordered list that holds at most `limit + 1`
 * matches after the cursor. The extra match only tells whether another page
 * follows.
 */
export function toChannelPage(ordered: readonly Channel[], limit: number): ChannelPage {
  const page = ordered.slice(0, limit);
  const last = page.at(-1);
  return last && ordered.length > page.length
    ? { channels: page, nextCursor: encodeChannelCursor(last) }
    : { channels: page };
}

/**
 * Filters, orders and pages channels held in memory. The memory and Redis
 * stores use it; the PostgreSQL store runs the same rules in SQL.
 */
export function pageChannels(
  channels: Iterable<Channel>,
  filter: ChannelListFilter = {},
): ChannelPage {
  const limit = parseChannelPageLimit(filter.limit);
  const cursor = filter.cursor === undefined ? undefined : decodeChannelCursor(filter.cursor);
  const ordered = [...channels]
    .filter((channel) => channelMatches(channel, filter))
    .sort(compareChannels)
    .filter((channel) => cursor === undefined || isAfterCursor(channel, cursor));
  return toChannelPage(ordered.slice(0, limit + 1), limit);
}
