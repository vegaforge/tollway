/**
 * The MPP channel lifecycle manager. See docs/design.md,
 * "The channel lifecycle manager".
 *
 * Scope of this implementation: `open` and `commit`. `close`, `recover`,
 * and `shouldClose` are tracked under separate issues and remain as
 * typed stubs.
 */

import { NotImplementedError } from "@tollway/core";
import type { MppChannelAdapter, OpenAdapterResult, SignedCommitment } from "./adapter.js";
import {
  ChannelNotFoundError,
  ChannelNotOpenError,
  CommitmentExceedsDepositError,
  InvalidAmountError,
} from "./errors.js";
import { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
import type {
  Channel,
  ChannelManager,
  ClosePolicy,
  Commitment,
  OpenChannelInput,
} from "./types.js";

const AMOUNT_RE = /^[0-9]+$/;

function parseAmount(value: string, field: string): bigint {
  if (!AMOUNT_RE.test(value)) throw new InvalidAmountError(value, field);
  return BigInt(value);
}

export type CreateChannelManagerOptions = {
  adapter: MppChannelAdapter;
  store?: CommitmentStore;
  closePolicy?: ClosePolicy;
};

export function createChannelManager(options: CreateChannelManagerOptions): ChannelManager {
  const { adapter, store = createMemoryCommitmentStore() } = options;

  return {
    async open(input: OpenChannelInput): Promise<Channel> {
      const deposit = parseAmount(input.deposit, "deposit");
      if (deposit === 0n) throw new InvalidAmountError(input.deposit, "deposit");

      const opened: OpenAdapterResult = await adapter.openChannel({
        counterparty: input.counterparty,
        asset: input.asset,
        deposit: input.deposit,
        network: input.network,
      });

      const channel: Channel = {
        id: opened.channelId,
        counterparty: input.counterparty,
        asset: input.asset,
        deposit: input.deposit,
        committed: "0",
        sequence: -1,
        status: "open",
        network: input.network,
        openTxHash: opened.openTxHash,
      };

      await store.putChannel(channel);
      return channel;
    },

    async commit(channelId: string, amount: string): Promise<Commitment> {
      const delta = parseAmount(amount, "amount");
      if (delta === 0n) throw new InvalidAmountError(amount, "amount");

      const current = await store.getChannel(channelId);
      if (!current) throw new ChannelNotFoundError(channelId);
      if (current.status !== "open") {
        throw new ChannelNotOpenError(channelId, current.status);
      }

      const committed = parseAmount(current.committed, "committed");
      const deposit = parseAmount(current.deposit, "deposit");
      const nextCumulative = committed + delta;

      if (nextCumulative > deposit) {
        throw new CommitmentExceedsDepositError(
          channelId,
          nextCumulative.toString(),
          current.deposit,
        );
      }

      const nextSequence = current.sequence + 1;
      const cumulativeAmount = nextCumulative.toString();

      const signed: SignedCommitment = await adapter.signCommitment({
        channelId,
        cumulativeAmount,
        network: current.network,
      });

      const commitment: Commitment = {
        channelId,
        sequence: nextSequence,
        cumulativeAmount,
        commitment: signed.commitment,
      };

      await store.appendCommitment(commitment);
      await store.updateChannel(channelId, {
        committed: cumulativeAmount,
        sequence: nextSequence,
      });

      return commitment;
    },

    async get(channelId: string): Promise<Channel | undefined> {
      return store.getChannel(channelId);
    },

    async list(channelId: string): Promise<readonly Commitment[]> {
      const channel = await store.getChannel(channelId);
      if (!channel) throw new ChannelNotFoundError(channelId);
      return store.listCommitments(channelId);
    },

    async shouldClose(_channelId: string): Promise<boolean> {
      throw new NotImplementedError(
        "ChannelManager.shouldClose",
        'docs/design.md, "The channel lifecycle manager"',
      );
    },

    async close(_channelId: string) {
      throw new NotImplementedError(
        "ChannelManager.close",
        'docs/design.md, "The channel lifecycle manager"',
      );
    },

    async recover(_channelId: string) {
      throw new NotImplementedError(
        "ChannelManager.recover",
        'docs/design.md, "The channel lifecycle manager"',
      );
    },
  };
}
