/**
 * The persistence boundary for tracked channels and their commitment streams.
 *
 * For now the only implementation is in-memory and process-local. The
 * interface is here so the same manager can switch to a durable store
 * (Redis, SQLite, the optional shared service) without changing the manager.
 */

import type { Channel, Commitment } from "./types.js";

export interface CommitmentStore {
  putChannel(channel: Channel): Promise<void>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  updateChannel(channelId: string, patch: Partial<Channel>): Promise<Channel | undefined>;
  appendCommitment(commitment: Commitment): Promise<void>;
  listCommitments(channelId: string): Promise<readonly Commitment[]>;
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
  };
}
