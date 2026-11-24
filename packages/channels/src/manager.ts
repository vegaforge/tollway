/**
 * The MPP channel lifecycle manager. See docs/design.md,
 * "The channel lifecycle manager".
 *
 * Scope of this release: `open`, `commit`, `listChannels`, `shouldClose`,
 * `close`, `resume` and `resumeAll` for closes a crash or an unknown outcome
 * left in `closing` (#176), and `recover` for the funder's close_start and
 * refund path (#38). The funder-side contract calls behind the adapter's
 * `startClose` and `refund` are the Stellar adapter's follow-up (#101).
 */

import type { CounterpartyQuarantine } from "@vegaforge/tollway-core";
import type {
  CloseAdapterResult,
  MppChannelAdapter,
  OpenAdapterResult,
  SignedCommitment,
  StartCloseResult,
} from "./adapter.js";
import {
  ChannelAlreadyClosedError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  CloseNotSubmittedError,
  CommitmentConflictError,
  CommitmentExceedsDepositError,
  CounterpartyQuarantinedError,
  InvalidAmountError,
  RecoveryNotYetEffectiveError,
  SettlementMismatchError,
  SettlementNotFoundError,
} from "./errors.js";
import type { ChannelEventHandler, ChannelLifecycleEvent } from "./events.js";
import { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
import type {
  Channel,
  ChannelListFilter,
  ChannelManager,
  ChannelPage,
  ChannelStatus,
  ClosePolicy,
  CloseResult,
  Commitment,
  OpenChannelInput,
  RecoveryResult,
  ResumeAllResult,
  ResumeOutcome,
} from "./types.js";

const AMOUNT_RE = /^[0-9]+$/;

function settledFields(
  settlement: Pick<CloseAdapterResult, "settlementTxHash" | "returnedRemainder">,
): { settlementTxHash: string; returnedRemainder: string } {
  return {
    settlementTxHash: settlement.settlementTxHash,
    returnedRemainder: settlement.returnedRemainder,
  };
}

function parseAmount(value: string, field: string): bigint {
  if (!AMOUNT_RE.test(value)) throw new InvalidAmountError(value, field);
  return BigInt(value);
}

export type CreateChannelManagerOptions = {
  adapter: MppChannelAdapter;
  store?: CommitmentStore;
  closePolicy?: ClosePolicy;
  /**
   * Optional quarantine store. When provided, `open` and `commit` refuse
   * quarantined counterparties (and fail closed if lookup throws). `close`
   * remains allowed so funds can be settled or recovered.
   */
  quarantine?: CounterpartyQuarantine;
  /**
   * Clock function returning the current time as an ISO-8601 string. Defaults
   * to `() => new Date().toISOString()`. Override in tests to make
   * idle-timeout assertions deterministic.
   */
  now?: () => string;
  /**
   * Receives lifecycle events (#187): `channel:opened`, `channel:closing`,
   * `channel:closed` and `channel:close-failed`, plus `channel:recovering`
   * and `channel:recovered` from `recover` (#38). Each is emitted after the
   * matching store write succeeds. The handler is not awaited, and a handler
   * that throws or rejects never changes the result of `open`, `close` or
   * `recover`: the error goes to `onEventError`.
   */
  onEvent?: ChannelEventHandler;
  /** Receives an error thrown or rejected by `onEvent`, with the event it was handling. */
  onEventError?: (error: Error, event: ChannelLifecycleEvent) => void;
};

export function createChannelManager(options: CreateChannelManagerOptions): ChannelManager {
  const {
    adapter,
    store = createMemoryCommitmentStore(),
    closePolicy,
    quarantine,
    now = () => new Date().toISOString(),
    onEvent,
    onEventError,
  } = options;

  function reportEventError(raw: unknown, event: ChannelLifecycleEvent): void {
    const error = raw instanceof Error ? raw : new Error(String(raw));
    try {
      onEventError?.(error, event);
    } catch {
      // The error hook is the last stop. Nothing is left to report to, and a
      // throwing hook must not change the result of open or close.
    }
  }

  /**
   * Hands an event to `onEvent` without waiting for it. A synchronous throw
   * and a rejected promise both go to `onEventError`, so an observer can
   * never change a payment outcome or leave an unhandled rejection.
   */
  function emit(event: ChannelLifecycleEvent): void {
    if (!onEvent) return;
    try {
      const result = onEvent(event);
      if (result && typeof result.then === "function") {
        result.then(undefined, (raw: unknown) => reportEventError(raw, event));
      }
    } catch (raw) {
      reportEventError(raw, event);
    }
  }

  function eventBase(channel: Channel) {
    return {
      at: now(),
      channelId: channel.id,
      counterparty: channel.counterparty,
      asset: channel.asset,
      network: channel.network,
    };
  }

  /** Resumes in progress in this process, by channel id. */
  const resuming = new Map<string, Promise<ResumeOutcome>>();
  /** Recoveries in progress, so concurrent calls cannot refund twice (#38). */
  const recovering = new Map<string, Promise<RecoveryResult>>();

  /**
   * The last task queued for each channel that has work in flight (#175).
   * Commits and closes on one channel take turns through this queue, so a
   * commit reads the sequence the previous commit wrote and a close reads the
   * final commitment stream. Channels do not wait for each other. An entry is
   * dropped once its queue drains, so the map only holds busy channels.
   */
  const channelQueues = new Map<string, Promise<void>>();

  function forgetIfIdle(channelId: string, tail: Promise<void>): void {
    if (channelQueues.get(channelId) === tail) channelQueues.delete(channelId);
  }

  /**
   * Runs `task` after every earlier task for `channelId` has settled. A task
   * that fails rejects only its own caller; the next task still runs.
   */
  function serialiseChannel<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const previous = channelQueues.get(channelId) ?? Promise.resolve();
    const run = previous.then(task);
    // The queue tail never rejects, so a failed task cannot stall the queue.
    const tail: Promise<void> = run.then(
      () => forgetIfIdle(channelId, tail),
      () => forgetIfIdle(channelId, tail),
    );
    channelQueues.set(channelId, tail);
    return run;
  }

  /**
   * Records the close attempt, then asks the adapter to close. The attempt
   * is written first so a process that dies mid-close leaves `closing` with
   * the ledger to search from. Only an adapter that says it submitted
   * nothing (`CloseNotSubmittedError`) returns the channel to `open`; any
   * other failure may have reached the chain, so the channel stays
   * `closing` for `resume` instead of being closed a second time.
   */
  async function submitClose(
    channel: Channel,
    startedAtLedger: number,
    expectedStatus: ChannelStatus,
  ): Promise<CloseResult> {
    const closeAttempt = {
      attemptId: globalThis.crypto.randomUUID(),
      startedAtLedger,
      startedAt: now(),
    };
    // Move to `closing` first, as a compare-and-set on the status. Commits
    // are conditioned on `open`, so once this lands no commitment can follow,
    // and the stream read below is the final one. A concurrent close loses
    // here and is refused instead of submitting a second close (#175).
    try {
      await store.transitionChannel(channel.id, expectedStatus, {
        status: "closing",
        closeAttempt,
      });
    } catch (error) {
      if (error instanceof CommitmentConflictError && error.field === "status") {
        throw new ChannelAlreadyClosedError(channel.id, error.actual);
      }
      throw error;
    }
    const stream = await store.listCommitments(channel.id);
    const latest = stream.at(-1);
    const cumulativeAmount = latest?.cumulativeAmount ?? "0";
    emit({ type: "channel:closing", ...eventBase(channel), cumulativeAmount });

    let settlement: CloseAdapterResult;
    try {
      settlement = await adapter.closeChannel({
        channelId: channel.id,
        network: channel.network,
        cumulativeAmount,
        commitment: latest?.commitment ?? "",
        deposit: channel.deposit,
      });
    } catch (error) {
      if (error instanceof CloseNotSubmittedError) {
        await store.updateChannel(channel.id, { status: "open", closeAttempt: undefined });
      }
      emit({
        type: "channel:close-failed",
        ...eventBase(channel),
        status: error instanceof CloseNotSubmittedError ? "open" : "closing",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
    await settle(channel, cumulativeAmount, settlement);
    return { channelId: channel.id, ...settledFields(settlement) };
  }

  /**
   * Records a settlement the chain reported. One that does not match the
   * last commitment is terminal: the chain and the commitment stream
   * disagree, and the channel must never take another commit.
   */
  async function settle(
    channel: Channel,
    cumulativeAmount: string,
    settlement: Pick<
      CloseAdapterResult,
      "settlementTxHash" | "settledAmount" | "returnedRemainder"
    >,
  ): Promise<void> {
    const channelId = channel.id;
    if (settlement.settledAmount !== cumulativeAmount) {
      await store.updateChannel(channelId, {
        status: "settlement-mismatched",
        ...settledFields(settlement),
        settlementMismatch: {
          expectedAmount: cumulativeAmount,
          observedAmount: settlement.settledAmount,
        },
      });
      const mismatch = new SettlementMismatchError(
        channelId,
        cumulativeAmount,
        settlement.settledAmount,
      );
      emit({
        type: "channel:close-failed",
        ...eventBase(channel),
        status: "settlement-mismatched",
        error: mismatch,
      });
      throw mismatch;
    }
    await store.updateChannel(channelId, { status: "closed", ...settledFields(settlement) });
    emit({
      type: "channel:closed",
      ...eventBase(channel),
      ...settledFields(settlement),
      settledAmount: settlement.settledAmount,
    });
  }

  async function resumeOnce(channelId: string): Promise<ResumeOutcome> {
    const current = await store.getChannel(channelId);
    if (!current) throw new ChannelNotFoundError(channelId);
    if (current.status !== "closing") {
      return { kind: "no-change", channelId, status: current.status };
    }
    const chain = await adapter.getChannelState({ channelId, network: current.network });

    if (chain.closeEffectiveAtLedger === undefined) {
      // Nothing closed on chain: the earlier attempt never landed. Close
      // again with the same commitment stream.
      const closed = await submitClose(current, chain.currentLedger, "closing");
      return { kind: "reclosed", ...closed };
    }

    if (parseAmount(chain.balance, "balance") > 0n) {
      // Closing with funds still in the contract is a funder-started close
      // or a dispute. That is the recovery path (#38), not a settlement.
      await store.updateChannel(channelId, {
        status: "recovering",
        closeEffectiveAtLedger: chain.closeEffectiveAtLedger,
      });
      emit({
        type: "channel:recovering",
        ...eventBase(current),
        closeEffectiveAtLedger: chain.closeEffectiveAtLedger,
      });
      return {
        kind: "recovering",
        channelId,
        closeEffectiveAtLedger: chain.closeEffectiveAtLedger,
      };
    }

    // Closed and empty: find the settlement and record it.
    const startLedger = current.closeAttempt?.startedAtLedger ?? chain.closeEffectiveAtLedger;
    const found = await adapter.findChannelSettlement({
      channelId,
      network: current.network,
      startLedger,
    });
    if (!found) throw new SettlementNotFoundError(channelId, startLedger);
    const stream = await store.listCommitments(channelId);
    await settle(current, stream.at(-1)?.cumulativeAmount ?? "0", found);
    return { kind: "closed", channelId, ...settledFields(found) };
  }

  /**
   * Moves a channel to `recovering` as a compare-and-set on the status it was
   * read with. Commits are conditioned on `open`, so once this lands no
   * commitment can follow, and a concurrent `close` or `recover` in another
   * process loses here instead of acting on the same channel.
   */
  async function markRecovering(channel: Channel, patch: Partial<Channel>): Promise<void> {
    try {
      await store.transitionChannel(channel.id, channel.status, {
        ...patch,
        status: "recovering",
      });
    } catch (error) {
      if (error instanceof CommitmentConflictError && error.field === "status") {
        throw new ChannelAlreadyClosedError(channel.id, error.actual);
      }
      throw error;
    }
  }

  /**
   * Drives one recovery from the chain's point of view (#38). Ledger numbers
   * come straight from the adapter; wall-clock time has no say in when a
   * refund is permitted. See docs/design.md, "Open questions", item 1.
   */
  async function recoverOnce(channelId: string): Promise<RecoveryResult> {
    const current = await store.getChannel(channelId);
    if (!current) throw new ChannelNotFoundError(channelId);
    if (
      current.status !== "open" &&
      current.status !== "closing" &&
      current.status !== "recovering"
    ) {
      throw new ChannelAlreadyClosedError(channelId, current.status);
    }

    const state = await adapter.getState({ channelId, network: current.network });
    const balance = parseAmount(state.balance, "balance");

    if (state.closeEffectiveAtLedger === undefined) {
      // Nothing is closing on chain, so the funder starts the close. The
      // status moves first: a crash after close_start lands leaves the
      // channel in `recovering`, and the next call reads the close back.
      if (current.status !== "recovering") await markRecovering(current, {});
      let started: StartCloseResult;
      try {
        started = await adapter.startClose({ channelId, network: current.network });
      } catch (error) {
        // Only an adapter that says nothing reached the chain hands the
        // channel back. Any other failure may have submitted close_start.
        if (error instanceof CloseNotSubmittedError) {
          await store.transitionChannel(channelId, "recovering", {
            status: current.status,
            closeEffectiveAtLedger: undefined,
          });
        }
        throw error;
      }
      await store.updateChannel(channelId, {
        closeEffectiveAtLedger: started.closeEffectiveAtLedger,
      });
      emit({
        type: "channel:recovering",
        ...eventBase(current),
        closeEffectiveAtLedger: started.closeEffectiveAtLedger,
      });
      return { channelId, recoveredAmount: "0", txHash: started.txHash };
    }

    if (balance === 0n) {
      // A recipient close pays out and returns the remainder in one
      // transaction, so an empty channel has already settled. Record that
      // settlement rather than refunding a zero balance.
      const startLedger = current.closeAttempt?.startedAtLedger ?? state.closeEffectiveAtLedger;
      const found = await adapter.findChannelSettlement({
        channelId,
        network: current.network,
        startLedger,
      });
      if (!found) throw new SettlementNotFoundError(channelId, startLedger);
      const stream = await store.listCommitments(channelId);
      await settle(current, stream.at(-1)?.cumulativeAmount ?? "0", found);
      return {
        channelId,
        recoveredAmount: found.returnedRemainder,
        txHash: found.settlementTxHash,
      };
    }

    // A close with funds left in the contract is a funder close. Record it
    // even when this process did not start it (a crash between close_start
    // and the store write, or a close started elsewhere), so no commit
    // follows and a later call knows the ledger to wait for.
    if (current.status !== "recovering") {
      await markRecovering(current, { closeEffectiveAtLedger: state.closeEffectiveAtLedger });
      emit({
        type: "channel:recovering",
        ...eventBase(current),
        closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      });
    } else if (current.closeEffectiveAtLedger !== state.closeEffectiveAtLedger) {
      await store.updateChannel(channelId, {
        closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      });
    }

    if (state.currentLedger <= state.closeEffectiveAtLedger) {
      throw new RecoveryNotYetEffectiveError(
        channelId,
        state.closeEffectiveAtLedger,
        state.currentLedger,
      );
    }

    const refunded = await adapter.refund({ channelId, network: current.network });
    parseAmount(refunded.refundedAmount, "refundedAmount");
    await store.transitionChannel(channelId, "recovering", {
      status: "recovered",
      closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      recoveredAmount: refunded.refundedAmount,
      refundTxHash: refunded.txHash,
    });
    emit({
      type: "channel:recovered",
      ...eventBase(current),
      recoveredAmount: refunded.refundedAmount,
      refundTxHash: refunded.txHash,
    });
    return {
      channelId,
      recoveredAmount: refunded.refundedAmount,
      txHash: refunded.txHash,
    };
  }

  async function assertNotQuarantined(counterparty: string): Promise<void> {
    if (!quarantine) return;
    let entry: Awaited<ReturnType<CounterpartyQuarantine["lookup"]>>;
    try {
      entry = await quarantine.lookup(counterparty);
    } catch (cause) {
      throw new CounterpartyQuarantinedError(
        counterparty,
        "quarantine lookup failed; failing closed",
        { cause },
      );
    }
    if (entry) {
      throw new CounterpartyQuarantinedError(counterparty, entry.reason, { entry });
    }
  }

  const manager: ChannelManager = {
    async open(input: OpenChannelInput): Promise<Channel> {
      const deposit = parseAmount(input.deposit, "deposit");
      if (deposit === 0n) throw new InvalidAmountError(input.deposit, "deposit");

      await assertNotQuarantined(input.counterparty);

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
      emit({
        type: "channel:opened",
        ...eventBase(channel),
        deposit: channel.deposit,
        openTxHash: channel.openTxHash,
      });
      return channel;
    },

    async commit(channelId: string, amount: string): Promise<Commitment> {
      const delta = parseAmount(amount, "amount");
      if (delta === 0n) throw new InvalidAmountError(amount, "amount");

      // Queued behind earlier commits and closes on this channel, so the read
      // below sees the state the last one left (#175).
      return serialiseChannel(channelId, async () => {
        const current = await store.getChannel(channelId);
        if (!current) throw new ChannelNotFoundError(channelId);
        if (current.status !== "open") {
          throw new ChannelNotOpenError(channelId, current.status);
        }

        await assertNotQuarantined(current.counterparty);

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

        // The queue already ordered this commit after the previous one in this
        // process. The compare-and-set still covers another process sharing the
        // store: if it got there first, this throws CommitmentConflictError and
        // the signed blob is dropped with it.
        await store.appendCommitment(commitment, {
          expectedSequence: current.sequence,
          expectedStatus: "open",
          lastCommitAt: now(),
        });

        return commitment;
      });
    },

    async get(channelId: string): Promise<Channel | undefined> {
      return store.getChannel(channelId);
    },

    async list(channelId: string): Promise<readonly Commitment[]> {
      const channel = await store.getChannel(channelId);
      if (!channel) throw new ChannelNotFoundError(channelId);
      return store.listCommitments(channelId);
    },

    async listChannels(filter?: ChannelListFilter): Promise<ChannelPage> {
      return store.listChannels(filter);
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
      // Queued behind any commit already in flight on this channel, so the
      // close settles the last recorded commitment (#175). A second close waits
      // here and then finds the channel no longer open.
      return serialiseChannel(channelId, async () => {
        const current = await store.getChannel(channelId);
        if (!current) throw new ChannelNotFoundError(channelId);
        if (current.status !== "open") {
          throw new ChannelAlreadyClosedError(channelId, current.status);
        }
        // Read the chain height before anything is written: if this fails,
        // nothing happened and the channel is still simply open.
        const chain = await adapter.getChannelState({ channelId, network: current.network });
        return submitClose(current, chain.currentLedger, "open");
      });
    },

    resume(channelId: string): Promise<ResumeOutcome> {
      // Two resumes of one channel in this process share one run, so at
      // most one close is submitted. Across processes that needs the
      // store's compare-and-set from #175.
      const running = resuming.get(channelId);
      if (running) return running;
      const run = resumeOnce(channelId).finally(() => resuming.delete(channelId));
      resuming.set(channelId, run);
      return run;
    },

    async resumeAll(): Promise<ResumeAllResult> {
      const stuck = await store.listChannelsByStatus("closing");
      const outcomes = await Promise.all(
        stuck.map(async (channel): Promise<ResumeAllResult["outcomes"][number]> => {
          try {
            return await manager.resume(channel.id);
          } catch (rawError) {
            const error = rawError instanceof Error ? rawError : new Error(String(rawError));
            return { kind: "error", channelId: channel.id, error };
          }
        }),
      );
      return { outcomes };
    },

    recover(channelId: string): Promise<RecoveryResult> {
      // One run per channel: a second caller waits for the same refund
      // instead of submitting its own.
      const running = recovering.get(channelId);
      if (running) return running;
      const run = recoverOnce(channelId).finally(() => recovering.delete(channelId));
      recovering.set(channelId, run);
      return run;
    },
  };
  return manager;
}
