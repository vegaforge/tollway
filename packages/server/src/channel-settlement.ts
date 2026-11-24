import { close } from "@stellar/mpp/channel/server";
import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { MPP_NETWORK, readChannelBalanceState } from "./channel-chain.js";
import {
  type ChannelRecord,
  type ChannelSettlementRecord,
  type ChannelStore,
  type CloseRateGuard,
  readChannelRecord,
} from "./channel-store.js";

/**
 * Recipient-side channel settlement (#174). Closes a channel on chain with the
 * latest voucher the gate accepted, when the service's triggers fire or when
 * an operator asks. See docs/mpp-channels.md, "Settlement".
 *
 * The order is fixed: the channel is frozen (`open` to `settling`, a
 * compare-and-set on the shared {@link ChannelStore}) before the voucher to
 * close with is read, so a voucher the gate accepts during the close cannot
 * be lost, and two processes cannot both send a close. A close that throws
 * leaves the channel `settling`; only {@link ChannelSettler.resolve}, reading
 * the chain, decides whether it may be sent again.
 */

/** When {@link ChannelSettler.evaluate} closes a channel. Every trigger is optional; any one firing is enough. */
export type SettlementTriggers = {
  /** Close once the accepted cumulative reaches this many base units. */
  minCumulative?: string;
  /**
   * Close once the accepted cumulative reaches this fraction of the channel's
   * on-chain balance. Compared in integers: `cumulative * denominator >= balance * numerator`.
   */
  balanceFraction?: { numerator: number; denominator: number };
  /** Close when no voucher has been accepted for this long. */
  idleMs?: number;
  /** Close channels registered this long ago. */
  maxChannelAgeMs?: number;
};

type StellarSigner = Parameters<typeof close>[0]["feePayer"]["envelopeSigner"];

/** Configuration for {@link createChannelSettler}. */
export type ChannelSettlerOptions = {
  /** The store the gate's channel handler writes to. */
  channels: ChannelStore;
  network: StellarNetwork;
  rpcUrl?: string;
  /** Pays for close transactions. Never logged or put in an error message. */
  feePayer: { envelopeSigner: StellarSigner; feeBumpSigner?: StellarSigner };
  /** Public key of the account that pays the fee (the fee-bump signer when there is one). */
  feePayerKey: string;
  /** Caps closes per fee payer. `@stellar/mpp`'s `feeBudget` does not cover the standalone `close`. */
  closeRateGuard: CloseRateGuard;
  /** Cap on one close's fee bump, in stroops. Defaults to `@stellar/mpp`'s default. */
  maxFeeBumpStroops?: number;
  pollMaxAttempts?: number;
  pollDelayMs?: number;
  pollTimeoutMs?: number;
  triggers?: SettlementTriggers;
  /** A channel closed and its record is stored. */
  onClosed?: (record: ChannelSettlementRecord) => void;
  /** A close threw; the channel stays settling until `resolve`. */
  onCloseFailed?: (info: { channelId: string; error: Error }) => void;
  /** The chain after a close does not show a closed, empty channel. */
  onCloseAnomaly?: (info: { channelId: string; detail: string }) => void;
  /** A timer-driven pass failed as a whole, for example listing the store threw. */
  onEvaluateError?: (error: Error) => void;
  clock?: () => number;
};

/** What one {@link ChannelSettler.settle} call did. */
export type ChannelSettleOutcome =
  | { status: "closed"; record: ChannelSettlementRecord }
  | { status: "already-closed"; record?: ChannelSettlementRecord }
  | {
      status: "skipped";
      reason: "no-accepted-voucher" | "in-progress" | "pending-voucher" | "not-registered";
    }
  | { status: "rate-limited" }
  | { status: "failed"; error: string };

/** What {@link ChannelSettler.resolve} found on chain. */
export type ChannelResolveOutcome =
  | { status: "not-settling" }
  | { status: "closed" }
  | { status: "retryable"; reason: "close-not-on-chain" | "funder-dispute" };

/** One {@link ChannelSettler.evaluate} pass. */
export type ChannelEvaluationReport = {
  /** Channels a trigger fired for, with what `settle` did. */
  results: Array<{ channelId: string; outcome: ChannelSettleOutcome }>;
  /** Channels whose triggers could not be checked, for example an RPC failure reading the balance. */
  errors: Array<{ channelId: string; error: string }>;
};

/** Closes received channels on chain. */
export type ChannelSettler = {
  /** Closes one channel with its latest accepted voucher. */
  settle(channelId: string): Promise<ChannelSettleOutcome>;
  /** Closes every open channel whose triggers fire. Pure pass, no timers. */
  evaluate(): Promise<ChannelEvaluationReport>;
  /** Reads the chain for a `settling` channel and records whether it closed or may be retried. */
  resolve(channelId: string): Promise<ChannelResolveOutcome>;
  /** Runs `evaluate` every `intervalMs`, on an unref'd timer. Optional helper. */
  start(input: { intervalMs: number }): void;
  /** Stops the timer and waits for a running pass to finish. */
  stop(): Promise<void>;
};

/** Validates triggers. Throws a TypeError naming the first invalid one. */
export function validateSettlementTriggers(triggers: SettlementTriggers): void {
  if (triggers.minCumulative !== undefined && !/^[1-9][0-9]*$/.test(triggers.minCumulative)) {
    throw new TypeError("triggers.minCumulative must be a positive integer string");
  }
  if (triggers.balanceFraction) {
    const { numerator, denominator } = triggers.balanceFraction;
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
      throw new TypeError("triggers.balanceFraction must use integers");
    }
    if (numerator <= 0 || denominator <= 0 || numerator > denominator) {
      throw new TypeError("triggers.balanceFraction must satisfy 0 < numerator <= denominator");
    }
  }
  for (const name of ["idleMs", "maxChannelAgeMs"] as const) {
    const value = triggers[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`triggers.${name} must be a positive integer`);
    }
  }
}

/** Decodes a 128-character hex signature to its 64 bytes. */
export function hexSignatureBytes(signature: string): Uint8Array {
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
    throw new TollwayError(
      "invalid-signature-encoding",
      "voucher signature must be 128 hex characters",
    );
  }
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    bytes[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Builds a {@link ChannelSettler}. Invalid triggers throw here, not at the first pass. */
export function createChannelSettler(options: ChannelSettlerOptions): ChannelSettler {
  const triggers = options.triggers ?? {};
  validateSettlementTriggers(triggers);
  if (!options.feePayerKey) {
    throw new TypeError("createChannelSettler: feePayerKey is required");
  }
  const clock = options.clock ?? Date.now;
  const chain = {
    network: options.network,
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  };

  async function write(
    current: ChannelRecord,
    next: Omit<ChannelRecord, "version">,
  ): Promise<ChannelRecord | null> {
    const record: ChannelRecord = { ...next, version: current.version + 1 };
    return (await options.channels.compareAndSet(current.channelId, current.version, record))
      ? record
      : null;
  }

  async function settle(channelId: string): Promise<ChannelSettleOutcome> {
    const record = await readChannelRecord(options.channels, channelId);
    if (!record) return { status: "skipped", reason: "not-registered" };
    if (record.status === "closed") {
      return record.settlement?.record
        ? { status: "already-closed", record: record.settlement.record }
        : { status: "already-closed" };
    }
    if (record.pending) return { status: "skipped", reason: "pending-voucher" };
    const retrying = record.status === "settling";
    if (retrying && !record.settlement?.retryable) {
      return { status: "skipped", reason: "in-progress" };
    }
    // A channel with nothing accepted owes the service nothing.
    if (!record.latest) return { status: "skipped", reason: "no-accepted-voucher" };

    if (!(await options.closeRateGuard.tryAcquire(options.feePayerKey, clock()))) {
      return { status: "rate-limited" };
    }

    // Freeze first. From here the gate rejects vouchers on this channel, and
    // a second process loses this compare-and-set.
    const frozen = await write(record, {
      ...record,
      status: "settling",
      settlement: {
        startedAt: record.settlement?.startedAt ?? clock(),
        trigger: record.settlement?.trigger ?? "service",
        retryable: false,
      },
    });
    if (!frozen) return { status: "skipped", reason: "in-progress" };
    // The voucher to close with is the one in the frozen record: the gate can
    // no longer change it.
    const voucher = frozen.latest;
    if (!voucher) return { status: "skipped", reason: "no-accepted-voucher" };

    let balanceBefore: string;
    try {
      balanceBefore = (await readChannelBalanceState(channelId, chain)).balance;
    } catch (error) {
      // Nothing was sent, so the close may simply be tried again.
      await markRetryable(frozen, `balance read failed: ${errorMessage(error)}`);
      return { status: "failed", error: `channel-state-unavailable: ${errorMessage(error)}` };
    }

    let txHash: string;
    try {
      txHash = await close({
        channel: channelId,
        amount: BigInt(voucher.cumulativeAmount),
        signature: hexSignatureBytes(voucher.signature),
        feePayer: options.feePayer,
        network: MPP_NETWORK[options.network],
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        ...(options.maxFeeBumpStroops !== undefined
          ? { maxFeeBumpStroops: options.maxFeeBumpStroops }
          : {}),
        ...(options.pollMaxAttempts !== undefined
          ? { pollMaxAttempts: options.pollMaxAttempts }
          : {}),
        ...(options.pollDelayMs !== undefined ? { pollDelayMs: options.pollDelayMs } : {}),
        ...(options.pollTimeoutMs !== undefined ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
      });
    } catch (error) {
      // The close may have been broadcast, so the channel stays settling and
      // is not retryable until resolve() reads the chain.
      const message = errorMessage(error);
      const latest = await readChannelRecord(options.channels, channelId);
      if (latest?.settlement) {
        await write(latest, {
          ...latest,
          settlement: { ...latest.settlement, balanceBefore, retryable: false, lastError: message },
        });
      }
      options.onCloseFailed?.({ channelId, error: asError(error) });
      return { status: "failed", error: message };
    }

    const amount = BigInt(voucher.cumulativeAmount);
    const before = BigInt(balanceBefore);
    const settlementRecord: ChannelSettlementRecord = {
      channelId,
      settledAmount: voucher.cumulativeAmount,
      returnedRemainder: (before > amount ? before - amount : 0n).toString(),
      txHash,
    };
    await recordClosed(channelId, settlementRecord, balanceBefore);
    await checkClosedOnChain(channelId);
    options.onClosed?.(settlementRecord);
    return { status: "closed", record: settlementRecord };
  }

  async function markRetryable(current: ChannelRecord, lastError: string): Promise<void> {
    if (!current.settlement) return;
    await write(current, {
      ...current,
      settlement: { ...current.settlement, retryable: true, lastError },
    });
  }

  async function recordClosed(
    channelId: string,
    settlementRecord: ChannelSettlementRecord,
    balanceBefore: string,
  ): Promise<void> {
    // Only this settler writes a settling channel it froze, so a lost race
    // here means the store itself failed. Retry from a fresh read once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await readChannelRecord(options.channels, channelId);
      if (!current?.settlement) break;
      const written = await write(current, {
        ...current,
        status: "closed",
        settlement: {
          ...current.settlement,
          balanceBefore,
          retryable: false,
          record: settlementRecord,
          closedAt: clock(),
        },
      });
      if (written) return;
    }
    throw new TollwayError(
      "outcome-unknown",
      `channel ${channelId} closed on chain in ${settlementRecord.txHash} but the record could not be stored`,
    );
  }

  async function checkClosedOnChain(channelId: string): Promise<void> {
    try {
      const after = await readChannelBalanceState(channelId, chain);
      if (after.closeEffectiveAtLedger === null || after.balance !== "0") {
        options.onCloseAnomaly?.({
          channelId,
          detail: `after close: balance ${after.balance}, closeEffectiveAtLedger ${String(after.closeEffectiveAtLedger)}`,
        });
      }
    } catch (error) {
      options.onCloseAnomaly?.({
        channelId,
        detail: `could not read state after close: ${errorMessage(error)}`,
      });
    }
  }

  async function resolve(channelId: string): Promise<ChannelResolveOutcome> {
    const record = await readChannelRecord(options.channels, channelId);
    if (record?.status !== "settling") return { status: "not-settling" };
    const state = await readChannelBalanceState(channelId, chain);
    if (state.closeEffectiveAtLedger !== null && state.balance === "0") {
      // Closed on chain, but the hash of the transaction that did it is not
      // known here; the record is left without one for reconciliation.
      const written = await write(record, {
        ...record,
        status: "closed",
        settlement: {
          startedAt: record.settlement?.startedAt ?? clock(),
          trigger: record.settlement?.trigger ?? "service",
          ...(record.settlement?.balanceBefore
            ? { balanceBefore: record.settlement.balanceBefore }
            : {}),
          retryable: false,
          closedAt: clock(),
        },
      });
      if (!written)
        throw new TollwayError("outcome-unknown", `channel ${channelId} changed during resolve`);
      return { status: "closed" };
    }
    const reason = state.closeEffectiveAtLedger === null ? "close-not-on-chain" : "funder-dispute";
    if (!record.settlement) {
      throw new TollwayError(
        "corrupt-channel-record",
        `settling channel ${channelId} has no settlement entry`,
      );
    }
    const written = await write(record, {
      ...record,
      settlement: { ...record.settlement, retryable: true },
    });
    if (!written)
      throw new TollwayError("outcome-unknown", `channel ${channelId} changed during resolve`);
    return { status: "retryable", reason };
  }

  async function due(record: ChannelRecord, now: number): Promise<boolean> {
    const latest = record.latest;
    if (!latest) return false;
    const cumulative = BigInt(latest.cumulativeAmount);
    if (triggers.minCumulative !== undefined && cumulative >= BigInt(triggers.minCumulative))
      return true;
    if (triggers.idleMs !== undefined && now - latest.acceptedAt >= triggers.idleMs) return true;
    if (
      triggers.maxChannelAgeMs !== undefined &&
      now - record.registeredAt >= triggers.maxChannelAgeMs
    ) {
      return true;
    }
    if (triggers.balanceFraction) {
      const { numerator, denominator } = triggers.balanceFraction;
      const balance = BigInt((await readChannelBalanceState(record.channelId, chain)).balance);
      if (cumulative * BigInt(denominator) >= balance * BigInt(numerator)) return true;
    }
    return false;
  }

  async function evaluate(): Promise<ChannelEvaluationReport> {
    const report: ChannelEvaluationReport = { results: [], errors: [] };
    const now = clock();
    for (const record of await options.channels.list()) {
      if (record.status !== "open" || record.pending || !record.latest) continue;
      try {
        if (!(await due(record, now))) continue;
        report.results.push({
          channelId: record.channelId,
          outcome: await settle(record.channelId),
        });
      } catch (error) {
        report.errors.push({ channelId: record.channelId, error: errorMessage(error) });
      }
    }
    return report;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<ChannelEvaluationReport> | undefined;
  function runPass(): void {
    if (running) return;
    running = evaluate().finally(() => {
      running = undefined;
    });
    // Per-channel failures are in the report. A pass that fails as a whole
    // goes to the hook, so the timer never leaves a rejection unhandled.
    running.catch((error: unknown) => {
      options.onEvaluateError?.(asError(error));
    });
  }

  return {
    settle,
    evaluate,
    resolve,
    start({ intervalMs }) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new TypeError("intervalMs must be a positive integer");
      }
      if (timer !== undefined) return;
      timer = setInterval(runPass, intervalMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // A pass that failed was already reported to onEvaluateError by runPass;
      // stop() only waits for it to end.
      if (running)
        await running.then(
          () => undefined,
          () => undefined,
        );
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
