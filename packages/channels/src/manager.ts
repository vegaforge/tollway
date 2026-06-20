/**
 * The MPP channel lifecycle manager. See docs/design.md,
 * "The channel lifecycle manager".
 *
 * Scope of this release: `open`, `commit`, `shouldClose`, and `close`.
 * `recover` is tracked under #38 and remains a typed stub.
 */

import { NotImplementedError } from "@tollway/core";
import type {
  CloseAdapterResult,
  MppChannelAdapter,
  OpenAdapterResult,
  SignedCommitment,
} from "./adapter.js";
import {
  ChannelAlreadyClosedError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  CommitmentExceedsDepositError,
  InvalidAmountError,
  SettlementMismatchError,
} from "./errors.js";
import { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
import type {
  Channel,
  ChannelManager,
  ClosePolicy,
  CloseResult,
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
  /**
   * Clock function returning the current time as an ISO-8601 string. Defaults
   * to `() => new Date().toISOString()`. Override in tests to make
   * idle-timeout assertions deterministic.
   */
  now?: () => string;
};

export function createChannelManager(options: CreateChannelManagerOptions): ChannelManager {
  const {
    adapter,
    store = createMemoryCommitmentStore(),
    closePolicy,
    now = () => new Date().toISOString(),
  } = options;

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
        openedAt: now(),
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
        lastCommitAt: now(),
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

    async shouldClose(channelId: string): Promise<boolean> {
      const channel = await store.getChannel(channelId);
      if (!channel) throw new ChannelNotFoundError(channelId);
      // Only open channels are candidates for closing. Once a close has
      // started (closing/closed/recovering/recovered) the answer is no.
      if (channel.status !== "open") return false;

      if (!closePolicy) return false;

      const { drawdownThreshold, idleTimeoutSeconds } = closePolicy;

      if (drawdownThreshold !== undefined) {
        if (!Number.isFinite(drawdownThreshold) || drawdownThreshold < 0 || drawdownThreshold > 1) {
          throw new InvalidAmountError(String(drawdownThreshold), "closePolicy.drawdownThreshold");
        }
        const committed = parseAmount(channel.committed, "committed");
        const deposit = parseAmount(channel.deposit, "deposit");
        if (deposit > 0n) {
          // Compare without floats: committed/deposit >= threshold
          //   ⇔ committed * SCALE >= deposit * round(threshold * SCALE).
          const SCALE = 1_000_000n;
          const scaledThreshold = BigInt(Math.round(drawdownThreshold * Number(SCALE)));
          if (committed * SCALE >= deposit * scaledThreshold) return true;
        }
      }

      if (idleTimeoutSeconds !== undefined) {
        if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) {
          throw new InvalidAmountError(
            String(idleTimeoutSeconds),
            "closePolicy.idleTimeoutSeconds",
          );
        }
        // When no commit has landed yet, fall back to the open timestamp;
        // a channel that sits idle from the start should still age out.
        const baselineIso = channel.lastCommitAt ?? channel.openedAt;
        const baseline = Date.parse(baselineIso);
        const current = Date.parse(now());
        if (Number.isFinite(baseline) && Number.isFinite(current)) {
          const idleSeconds = Math.floor((current - baseline) / 1000);
          if (idleSeconds >= idleTimeoutSeconds) return true;
        }
      }

      return false;
    },

    async close(channelId: string): Promise<CloseResult> {
      const current = await store.getChannel(channelId);
      if (!current) throw new ChannelNotFoundError(channelId);
      if (current.status !== "open") {
        throw new ChannelAlreadyClosedError(channelId, current.status);
      }

      const stream = await store.listCommitments(channelId);
      const latest = stream.at(-1);
      const cumulativeAmount = latest?.cumulativeAmount ?? "0";
      const commitmentBlob = latest?.commitment ?? "";

      // Transition to closing before reaching the adapter so a concurrent
      // close on the same channel sees the in-progress state and bails.
      await store.updateChannel(channelId, { status: "closing" });

      let settlement: CloseAdapterResult;
      try {
        settlement = await adapter.closeChannel({
          channelId,
          network: current.network,
          cumulativeAmount,
          commitment: commitmentBlob,
          deposit: current.deposit,
        });
      } catch (error) {
        // Roll the channel back to open so the caller can retry. The
        // adapter is responsible for not leaving a half-submitted tx on
        // chain; the manager just hands back a consistent local state.
        await store.updateChannel(channelId, { status: "open" });
        throw error;
      }

      // The adapter's settled amount must match the last commitment.
      // The reconcile engine in #50 catches under/over-settlement at the
      // off-chain/on-chain seam; this guard is an in-process belt-and-braces.
      if (settlement.settledAmount !== cumulativeAmount) {
        await store.updateChannel(channelId, { status: "open" });
        throw new SettlementMismatchError(channelId, cumulativeAmount, settlement.settledAmount);
      }

      await store.updateChannel(channelId, {
        status: "closed",
        settlementTxHash: settlement.settlementTxHash,
        returnedRemainder: settlement.returnedRemainder,
      });

      return {
        channelId,
        settlementTxHash: settlement.settlementTxHash,
        returnedRemainder: settlement.returnedRemainder,
      };
    },

    async recover(_channelId: string) {
      throw new NotImplementedError(
        "ChannelManager.recover",
        'docs/design.md, "The channel lifecycle manager"',
      );
    },
  };
}
