/**
 * The MPP channel lifecycle manager. See docs/design.md,
 * "The channel lifecycle manager".
 *
 * Scope of this release: `open`, `commit`, `shouldClose`, and `close`.
 * `recover` is tracked under #38 and remains a typed stub.
 */

import { NotImplementedError } from "@vegaforge/tollway-core";
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

      // Issue #176: persist a close attempt BEFORE the adapter call so a
      // crash in the middle leaves the channel recoverable. The attempt
      // records the ledger height we started at, which `resume` uses to
      // scope its settlement lookup.
      const startedState = await adapter.getChannelState({
        channelId,
        network: current.network,
      });
      const attempt = {
        attemptId: `close-${startedState.currentLedger}-${Date.now()}`,
        startedAtLedger: startedState.currentLedger,
        startedAt: now(),
      };
      await store.updateChannel(channelId, { status: "closing", closeAttempt: attempt });

      // Issue #176: a post-submit error (timeout, poll failure) is
      // indeterminate: the close may have landed on chain. Propagate
      // it with the channel still in `closing` and the attempt
      // recorded, so `resume` can ask the chain what happened.
      // Rolling back to `open` would let a second `close()` sign and
      // submit a second time.
      const settlement: CloseAdapterResult = await adapter.closeChannel({
        channelId,
        network: current.network,
        cumulativeAmount,
        commitment: commitmentBlob,
        deposit: current.deposit,
      });

      // Issue #176: the adapter's settled amount must match the last
      // commitment. A mismatch is a terminal state - the chain now
      // disagrees with our commitment stream and reopening the channel
      // would let the agent sign over that disagreement.
      if (settlement.settledAmount !== cumulativeAmount) {
        await store.updateChannel(channelId, {
          status: "settlement-mismatched",
          settlementTxHash: settlement.settlementTxHash,
          returnedRemainder: settlement.returnedRemainder,
          settlementMismatch: {
            expectedAmount: cumulativeAmount,
            observedAmount: settlement.settledAmount,
          },
        });
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

    async resume(channelId) {
      const current = await store.getChannel(channelId);
      if (!current) throw new ChannelNotFoundError(channelId);
      if (current.status !== "closing") {
        // Nothing to do; the channel is either still open (never
        // started), already closed, in recovery, or mismatched.
        return { kind: "no-change" as const, channelId, status: current.status };
      }
      const chain = await adapter.getChannelState({
        channelId,
        network: current.network,
      });
      // Case 1: close landed on chain already (closeEffectiveAtLedger is
      // set). If the balance is zero, we have a clean settlement; look
      // up the on-chain details and mark closed. If the balance is
      // non-zero, this is a funder-initiated close/recovery path and
      // belongs to #38.
      if (chain.closeEffectiveAtLedger !== undefined) {
        const balance = parseAmount(chain.balance, "balance");
        if (balance === 0n) {
          const startLedger = current.closeAttempt?.startedAtLedger ?? chain.closeEffectiveAtLedger;
          const found = await adapter.findChannelSettlement({
            channelId,
            network: current.network,
            startLedger,
          });
          if (!found) {
            // The chain says close is effective but we cannot locate
            // the settlement event. Leave the channel in closing and
            // surface the state so the caller can escalate.
            return { kind: "no-change" as const, channelId, status: current.status };
          }
          await store.updateChannel(channelId, {
            status: "closed",
            settlementTxHash: found.settlementTxHash,
            returnedRemainder: found.returnedRemainder,
          });
          return {
            kind: "closed" as const,
            channelId,
            settlementTxHash: found.settlementTxHash,
            returnedRemainder: found.returnedRemainder,
          };
        }
        // Non-zero balance with close effective: funder-initiated
        // recovery territory (#38). Mark recovering and hand off.
        await store.updateChannel(channelId, { status: "recovering" });
        return {
          kind: "recovering" as const,
          channelId,
          closeEffectiveAtLedger: chain.closeEffectiveAtLedger,
        };
      }
      // Case 2: no close on chain. The previous attempt died before
      // landing; retry the close under the existing commitment stream.
      const stream = await store.listCommitments(channelId);
      const latest = stream.at(-1);
      const cumulativeAmount = latest?.cumulativeAmount ?? "0";
      const commitmentBlob = latest?.commitment ?? "";
      const attempt = {
        attemptId: `resume-${chain.currentLedger}-${Date.now()}`,
        startedAtLedger: chain.currentLedger,
        startedAt: now(),
      };
      await store.updateChannel(channelId, { closeAttempt: attempt });
      const settlement = await adapter.closeChannel({
        channelId,
        network: current.network,
        cumulativeAmount,
        commitment: commitmentBlob,
        deposit: current.deposit,
      });
      if (settlement.settledAmount !== cumulativeAmount) {
        await store.updateChannel(channelId, {
          status: "settlement-mismatched",
          settlementTxHash: settlement.settlementTxHash,
          returnedRemainder: settlement.returnedRemainder,
          settlementMismatch: {
            expectedAmount: cumulativeAmount,
            observedAmount: settlement.settledAmount,
          },
        });
        throw new SettlementMismatchError(channelId, cumulativeAmount, settlement.settledAmount);
      }
      await store.updateChannel(channelId, {
        status: "closed",
        settlementTxHash: settlement.settlementTxHash,
        returnedRemainder: settlement.returnedRemainder,
      });
      return {
        kind: "reclosed" as const,
        channelId,
        settlementTxHash: settlement.settlementTxHash,
        returnedRemainder: settlement.returnedRemainder,
      };
    },

    async resumeAll() {
      const stuck = await store.listChannels({ status: "closing" });
      const outcomes = await Promise.all(
        stuck.map(async (channel) => {
          try {
            return await this.resume(channel.id);
          } catch (rawError) {
            const error = rawError instanceof Error ? rawError : new Error(String(rawError));
            return { kind: "error" as const, channelId: channel.id, error };
          }
        }),
      );
      return { outcomes };
    },

    async recover(_channelId: string) {
      throw new NotImplementedError(
        "ChannelManager.recover",
        'docs/design.md, "The channel lifecycle manager"',
      );
    },
  };
}
