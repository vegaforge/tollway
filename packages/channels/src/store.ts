/**
 * The persistence boundary for tracked channels and their commitment streams.
 *
 * Every write that depends on the state a channel is in is a compare-and-set
 * (#175). The caller says what it read (the sequence, or the status), and the
 * store applies the write only if it still holds that state. The check and
 * the write are one atomic step, so two processes that share a store cannot
 * both advance the same channel. A lost race throws
 * `CommitmentConflictError` and writes nothing.
 *
 * The memory store is process-local. The PostgreSQL and Redis stores in
 * `./stores` meet the same contract across processes; the shared conformance
 * suite in `./testing/store-conformance.ts` holds them to it.
 */

import { ChannelNotFoundError, CommitmentConflictError } from "./errors.js";
import { pageChannels } from "./store-query.js";
import type {
  Channel,
  ChannelListFilter,
  ChannelPage,
  ChannelStatus,
  Commitment,
} from "./types.js";

/**
 * What a caller read before it appended a commitment. The append is applied
 * only if the channel still has this sequence and this status.
 */
export type CommitmentAppendExpectation = {
  /** The channel's `sequence` the caller read. The commitment must follow it. */
  expectedSequence: number;
  /** The channel's `status` the caller read. Normally `open`. */
  expectedStatus: ChannelStatus;
  /** ISO-8601 time recorded as the channel's `lastCommitAt`. */
  lastCommitAt: string;
};

export interface CommitmentStore {
  putChannel(channel: Channel): Promise<void>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  /**
   * Applies `patch` to the channel with no condition. An unknown id resolves
   * `undefined`. Use `transitionChannel` or `appendCommitment` when the write
   * depends on the current state.
   */
  updateChannel(channelId: string, patch: Partial<Channel>): Promise<Channel | undefined>;
  /**
   * Atomically appends `commitment` and advances the channel record:
   * `committed` becomes the commitment's `cumulativeAmount`, `sequence`
   * becomes its `sequence`, and `lastCommitAt` becomes the expectation's time.
   *
   * The whole write happens only if the channel's current status equals
   * `expectedStatus` and its current sequence equals `expectedSequence`, and
   * the commitment's sequence is `expectedSequence + 1`. Otherwise it throws
   * `CommitmentConflictError` and writes nothing: no commitment, no change to
   * the channel. A missing channel throws `ChannelNotFoundError`. Resolves the
   * advanced channel record.
   */
  appendCommitment(
    commitment: Commitment,
    expectation: CommitmentAppendExpectation,
  ): Promise<Channel>;
  /**
   * Atomically applies `patch` (which should set the new `status`) only if
   * the channel's current status equals `expectedStatus`. Otherwise it throws
   * `CommitmentConflictError` with field `status` and writes nothing. A
   * missing channel throws `ChannelNotFoundError`. Resolves the updated record.
   */
  transitionChannel(
    channelId: string,
    expectedStatus: ChannelStatus,
    patch: Partial<Channel>,
  ): Promise<Channel>;
  /** Every commitment on the channel, ordered by sequence. Empty for an unknown id. */
  listCommitments(channelId: string): Promise<readonly Commitment[]>;
  /**
   * Every tracked channel in one status, in no particular order.
   * `resumeAll` uses it to find the channels a crash left in `closing` (#176).
   * It is deliberately narrow: the paged, filtered listing the service
   * endpoints need is `listChannels` (#179, #227).
   */
  listChannelsByStatus(status: Channel["status"]): Promise<readonly Channel[]>;
  /**
   * Every tracked channel, newest first (`openedAt`, then id, both
   * descending), filtered and paginated (#179, #227). Filters are exact
   * matches; an absent filter matches every channel. `limit` is 1 to 200 and
   * defaults to 50. A cursor from one page resumes exactly after the last
   * channel it returned, even when a channel's status changed in between. A
   * bad `limit` or a cursor the store did not issue throws `RangeError`.
   * Every store returns the same pages for the same data.
   */
  listChannels(filter?: ChannelListFilter): Promise<ChannelPage>;
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
    // No await inside the two compare-and-set methods below: the check and
    // the write run in one synchronous step, so no other call can interleave.
    async appendCommitment(commitment, expectation) {
      const current = channels.get(commitment.channelId);
      if (!current) throw new ChannelNotFoundError(commitment.channelId);
      if (current.status !== expectation.expectedStatus) {
        throw new CommitmentConflictError(
          commitment.channelId,
          "status",
          expectation.expectedStatus,
          current.status,
        );
      }
      const expectedNext = expectation.expectedSequence + 1;
      if (current.sequence !== expectation.expectedSequence) {
        throw new CommitmentConflictError(
          commitment.channelId,
          "sequence",
          String(expectation.expectedSequence),
          String(current.sequence),
        );
      }
      if (commitment.sequence !== expectedNext) {
        throw new CommitmentConflictError(
          commitment.channelId,
          "sequence",
          String(expectedNext),
          String(commitment.sequence),
        );
      }
      const next: Channel = {
        ...current,
        committed: commitment.cumulativeAmount,
        sequence: commitment.sequence,
        lastCommitAt: expectation.lastCommitAt,
      };
      channels.set(commitment.channelId, next);
      const stream = commitments.get(commitment.channelId) ?? [];
      stream.push(commitment);
      commitments.set(commitment.channelId, stream);
      return next;
    },
    async transitionChannel(channelId, expectedStatus, patch) {
      const current = channels.get(channelId);
      if (!current) throw new ChannelNotFoundError(channelId);
      if (current.status !== expectedStatus) {
        throw new CommitmentConflictError(channelId, "status", expectedStatus, current.status);
      }
      const next = { ...current, ...patch };
      channels.set(channelId, next);
      return next;
    },
    async listCommitments(channelId) {
      const stream = commitments.get(channelId) ?? [];
      return [...stream].sort((a, b) => a.sequence - b.sequence);
    },
    async listChannelsByStatus(status) {
      return [...channels.values()].filter((channel) => channel.status === status);
    },
    async listChannels(filter = {}) {
      return pageChannels(channels.values(), filter);
    },
  };
}
