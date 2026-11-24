/**
 * The filter, order and page rules for `CommitmentStore.listChannels` (#179).
 * Every store uses these, so the memory, PostgreSQL and Redis stores answer
 * the same query the same way. The conformance suite checks that they do.
 */

import { TollwayError } from "@vegaforge/tollway-core";
import type {
  Channel,
  ChannelFilter,
  ChannelListPage,
  ChannelListRequest,
} from "./types.js";

export const DEFAULT_CHANNEL_PAGE_LIMIT = 50;
export const MAX_CHANNEL_PAGE_LIMIT = 500;

/** Validated page request. `after` is the channel id to start after, if any. */
export type ParsedChannelListRequest = { limit: number; after: string | undefined };

/**
 * Checks the page size and returns the values a store needs. A size outside
 * 1 to 500 is a caller error and throws `invalid-channel-query`, not a
 * silent clamp.
 */
export function parseChannelListRequest(request?: ChannelListRequest): ParsedChannelListRequest {
  const limit = request?.limit ?? DEFAULT_CHANNEL_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANNEL_PAGE_LIMIT) {
    throw new TollwayError(
      "invalid-channel-query",
      `limit must be an integer from 1 to ${MAX_CHANNEL_PAGE_LIMIT}, got ${String(limit)}`,
    );
  }
  return { limit, after: request?.cursor };
}

/** True when the channel satisfies every filter field that is set. */
export function channelMatches(channel: Channel, filter: ChannelFilter): boolean {
  if (filter.status !== undefined && channel.status !== filter.status) return false;
  if (filter.counterparty !== undefined && channel.counterparty !== filter.counterparty) {
    return false;
  }
  if (filter.asset !== undefined && channel.asset !== filter.asset) return false;
  if (filter.network !== undefined && channel.network !== filter.network) return false;
  return true;
}

/**
 * Filters the channels, orders them by id ascending (by UTF-16 code unit, so
 * every store agrees), and returns one page after the cursor. `nextCursor` is
 * set only when more matching channels follow the page.
 */
export function pageChannels(
  channels: Iterable<Channel>,
  filter: ChannelFilter,
  request?: ChannelListRequest,
): ChannelListPage {
  const { limit, after } = parseChannelListRequest(request);
  const matching = [...channels]
    .filter((channel) => channelMatches(channel, filter))
    .filter((channel) => after === undefined || channel.id > after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pageItems = matching.slice(0, limit);
  const last = pageItems.at(-1);
  if (matching.length > limit && last !== undefined) {
    return { channels: pageItems, nextCursor: last.id };
  }
  return { channels: pageItems };
}
