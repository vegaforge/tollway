/**
 * Domain types for the MPP channel lifecycle manager.
 *
 * Field shapes that belong to @stellar/mpp (the commitment encoding, the
 * channel contract address format) are kept as opaque strings — the manager
 * is responsible for orchestration, not for the SDK's wire format.
 */

import type { StellarNetwork } from "@vegaforge/tollway-core";

export type ChannelStatus =
  | "open"
  | "closing"
  | "closed"
  | "recovering"
  | "recovered"
  /**
   * Issue #176: a terminal flag for a settlement that does not match the
   * last commitment. A channel in this state never accepts further
   * commits and is never reopened for the agent; the discrepancy is for
   * the reconcile path to classify.
   */
  | "settlement-mismatched";

export type OpenChannelInput = {
  counterparty: string;
  asset: string;
  /** Initial deposit as an integer string in the asset's smallest unit. */
  deposit: string;
  network: StellarNetwork;
};

export type Channel = {
  id: string;
  counterparty: string;
  asset: string;
  deposit: string;
  /** Total committed so far, cumulative. */
  committed: string;
  /** Highest commitment sequence issued. Starts at -1 before any commit lands. */
  sequence: number;
  status: ChannelStatus;
  network: StellarNetwork;
  /** On-chain transaction hash that opened the channel. */
  openTxHash: string;
  /** ISO-8601 timestamp the channel was opened. */
  openedAt: string;
  /**
   * ISO-8601 timestamp of the most recent successful commit. Absent before
   * the first commit lands. Used by the idle-timeout close heuristic.
   */
  lastCommitAt?: string;
  /** On-chain settlement tx hash; set when the channel transitions to closed. */
  settlementTxHash?: string;
  /** Amount returned to the funder on close; set when the channel transitions to closed. */
  returnedRemainder?: string;
  /**
   * Issue #176: records a close attempt before the on-chain submission.
   * After a crash, `resume()` reads this to decide what the chain should
   * be asked about. Absent on a channel that has never tried to close.
   */
  closeAttempt?: {
    /** A unique id per attempt (fresh on each `close()`). */
    attemptId: string;
    /** The ledger at which the attempt started (from the adapter). */
    startedAtLedger: number;
    /** ISO-8601 time the attempt started. */
    startedAt: string;
  };
  /**
   * Issue #176: set when the channel entered `settlement-mismatched`
   * carries the expected vs observed amounts for the reconcile path.
   */
  settlementMismatch?: {
    expectedAmount: string;
    observedAmount: string;
  };
};

export type Commitment = {
  channelId: string;
  sequence: number;
  cumulativeAmount: string;
  /** Funder-signed commitment blob; encoding owned by @stellar/mpp. */
  commitment: string;
};

export type CloseResult = {
  channelId: string;
  settlementTxHash: string;
  /** Amount returned to the funder after paying out the cumulative total. */
  returnedRemainder: string;
};

export type RecoveryResult = {
  channelId: string;
  recoveredAmount: string;
  txHash: string;
};

/**
 * Heuristics that decide when an open channel should close. See
 * docs/design.md, "The channel lifecycle manager".
 */
export type ClosePolicy = {
  /** Close once committed reaches this fraction of the deposit, 0 to 1. */
  drawdownThreshold?: number;
  /** Close after this many seconds with no new commitment. */
  idleTimeoutSeconds?: number;
};

export interface ChannelManager {
  open(input: OpenChannelInput): Promise<Channel>;
  commit(channelId: string, amount: string): Promise<Commitment>;
  /** Read-only access to the tracked channel record. */
  get(channelId: string): Promise<Channel | undefined>;
  /** Read-only access to a channel's commitment stream, ordered by sequence. */
  list(channelId: string): Promise<readonly Commitment[]>;
  shouldClose(channelId: string): Promise<boolean>;
  close(channelId: string): Promise<CloseResult>;
  /**
   * Issue #176: decides from chain state what actually happened to a
   * channel stuck in `closing` and moves it to the right terminal
   * status. Idempotent: calling it twice reaches the same state. See
   * `ResumeOutcome` for the shape of the answer.
   *
   * `resume` does not implement cross-process compare-and-set; two
   * processes resuming the same channel can both submit a retry close
   * on `no-close-on-chain` outcomes. The compare-and-set contract
   * belongs to #175; until it lands, run `resume` from one process at
   * a time.
   */
  resume(channelId: string): Promise<ResumeOutcome>;
  /**
   * Resumes every channel in `closing` and reports per-channel results.
   * Does not stop at the first failure; each channel's outcome includes
   * either the recovery decision or the error that prevented it.
   */
  resumeAll(): Promise<ResumeAllResult>;
  recover(channelId: string): Promise<RecoveryResult>;
}

/**
 * Issue #176: how `resume()` describes what it did. A `closed` outcome
 * reports the recovered settlement; `recovering` hands the channel to
 * the funder-initiated recovery path (#38); `reclosed` retried a close
 * that had not landed; `no-change` is a channel that was never in
 * `closing` to start with.
 */
export type ResumeOutcome =
  | { kind: "closed"; channelId: string; settlementTxHash: string; returnedRemainder: string }
  | { kind: "recovering"; channelId: string; closeEffectiveAtLedger: number }
  | { kind: "reclosed"; channelId: string; settlementTxHash: string; returnedRemainder: string }
  | { kind: "no-change"; channelId: string; status: ChannelStatus };

export type ResumeAllResult = {
  outcomes: ReadonlyArray<ResumeOutcome | { kind: "error"; channelId: string; error: Error }>;
};
