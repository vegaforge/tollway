/**
 * The MPP channel lifecycle manager. See docs/design.md,
 * "The channel lifecycle manager".
 *
 * Scope of this release: `open`, `commit`, `shouldClose`, `close`, `resume`
 * and `resumeAll` for closes a crash or an unknown outcome left in `closing`
 * (#176), and `recover` for the funder's close_start/refund path (#38). Real
 * funder-side contract calls are the Stellar adapter's follow-up (#101); the
 * manager orchestrates them through `MppChannelAdapter`.
 */

import type { CounterpartyQuarantine } from "@vegaforge/tollway-core";
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
  CloseNotSubmittedError,
  CommitmentExceedsDepositError,
  CounterpartyQuarantinedError,
  InvalidAmountError,
  RecoveryNotYetEffectiveError,
  SettlementMismatchError,
  SettlementNotFoundError,
} from "./errors.js";
import { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
import type {
  Channel,
  ChannelManager,
  ClosePolicy,
  CloseResult,
  Commitment,
  OpenChannelInput,
  RecoveryEvent,
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
   * Optional lifecycle event sink for recovery (#38). A throwing callback is
   * isolated: recovery completes regardless of what the observer does.
   */
  onEvent?: (event: RecoveryEvent) => void;
};

export function createChannelManager(options: CreateChannelManagerOptions): ChannelManager {
  const {
    adapter,
    store = createMemoryCommitmentStore(),
    closePolicy,
    quarantine,
    now = () => new Date().toISOString(),
    onEvent,
  } = options;

  /** Resumes in progress in this process, by channel id. */
  const resuming = new Map<string, Promise<ResumeOutcome>>();
  /** Recoveries in progress, so concurrent calls cannot refund twice (#38). */
  const recovering = new Map<string, Promise<RecoveryResult>>();

  function emitRecovery(event: RecoveryEvent): void {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // Events are advisory. A broken observer must not strand funds.
    }
  }

  /**
   * Records the close attempt, then asks the adapter to close. The attempt
   * is written first so a process that dies mid-close leaves `closing` with
   * the ledger to search from. Only an adapter that says it submitted
   * nothing (`CloseNotSubmittedError`) returns the channel to `open`; any
   * other failure may have reached the chain, so the channel stays
   * `closing` for `resume` instead of being closed a second time.
   */
  async function submitClose(channel: Channel, startedAtLedger: number): Promise<CloseResult> {
    const stream = await store.listCommitments(channel.id);
    const latest = stream.at(-1);
    const cumulativeAmount = latest?.cumulativeAmount ?? "0";
    const closeAttempt = {
      attemptId: globalThis.crypto.randomUUID(),
      startedAtLedger,
      startedAt: now(),
    };
    await store.updateChannel(channel.id, { status: "closing", closeAttempt });

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
      throw error;
    }
    await settle(channel.id, cumulativeAmount, settlement);
    return { channelId: channel.id, ...settledFields(settlement) };
  }

  /**
   * Records a settlement the chain reported. One that does not match the
   * last commitment is terminal: the chain and the commitment stream
   * disagree, and the channel must never take another commit.
   */
  async function settle(
    channelId: string,
    cumulativeAmount: string,
    settlement: Pick<
      CloseAdapterResult,
      "settlementTxHash" | "settledAmount" | "returnedRemainder"
    >,
  ): Promise<void> {
    if (settlement.settledAmount !== cumulativeAmount) {
      await store.updateChannel(channelId, {
        status: "settlement-mismatched",
        ...settledFields(settlement),
        settlementMismatch: {
          expectedAmount: cumulativeAmount,
          observedAmount: settlement.settledAmount,
        },
      });
      throw new SettlementMismatchError(channelId, cumulativeAmount, settlement.settledAmount);
    }
    await store.updateChannel(channelId, { status: "closed", ...settledFields(settlement) });
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
      const closed = await submitClose(current, chain.currentLedger);
      return { kind: "reclosed", ...closed };
    }

    if (parseAmount(chain.balance, "balance") > 0n) {
      // Closing with funds still in the contract is a funder-started close
      // or a dispute. That is the recovery path (#38), not a settlement.
      await store.updateChannel(channelId, { status: "recovering" });
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
    await settle(channelId, stream.at(-1)?.cumulativeAmount ?? "0", found);
    return { kind: "closed", channelId, ...settledFields(found) };
  }

  /**
   * Drives one recovery from the chain's point of view (#38). Ledger numbers
   * come straight from the adapter; wall-clock time has no say in when a
   * refund is permitted.
   */
  async function recoverOnce(channelId: string): Promise<RecoveryResult> {
    const current = await store.getChannel(channelId);
    if (!current) throw new ChannelNotFoundError(channelId);
    if (
      current.status === "closed" ||
      current.status === "recovered" ||
      current.status === "settlement-mismatched"
    ) {
      throw new ChannelAlreadyClosedError(channelId, current.status);
    }

    const state = await adapter.getState({ channelId, network: current.network });
    const balance = parseAmount(state.balance, "balance");

    if (state.closeEffectiveAtLedger === undefined) {
      const started = await adapter.startClose({ channelId, network: current.network });
      await store.updateChannel(channelId, {
        status: "recovering",
        closeEffectiveAtLedger: started.closeEffectiveAtLedger,
      });
      emitRecovery({ type: "channel:recovering", channelId });
      return { channelId, recoveredAmount: "0", txHash: started.txHash };
    }

    if (balance === 0n) {
      // A recipient close pays out and refunds the remainder in one
      // transaction, so an empty channel has already settled. Look the
      // settlement up rather than refunding a zero balance.
      const startLedger = current.closeAttempt?.startedAtLedger ?? state.closeEffectiveAtLedger;
      const found = await adapter.findChannelSettlement({
        channelId,
        network: current.network,
        startLedger,
      });
      if (!found) throw new SettlementNotFoundError(channelId, startLedger);
      const stream = await store.listCommitments(channelId);
      await settle(channelId, stream.at(-1)?.cumulativeAmount ?? "0", found);
      return {
        channelId,
        recoveredAmount: found.returnedRemainder,
        txHash: found.settlementTxHash,
      };
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
    await store.updateChannel(channelId, {
      status: "recovered",
      closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      recoveredAmount: refunded.refundedAmount,
      refundTxHash: refunded.txHash,
    });
    emitRecovery({ type: "channel:recovered", channelId });
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
      // Read the chain height before anything is written: if this fails,
      // nothing happened and the channel is still simply open.
      const chain = await adapter.getChannelState({ channelId, network: current.network });
      return submitClose(current, chain.currentLedger);
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
