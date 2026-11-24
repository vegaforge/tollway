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

/**
 * Filters and paging for {@link CommitmentStore.listChannels} and
 * {@link ChannelManager.listChannels}. Every filter is exact; there is no
 * prefix or range matching.
 */
export type ChannelListFilter = {
  status?: ChannelStatus;
  counterparty?: string;
  asset?: string;
  network?: StellarNetwork;
  /** `nextCursor` from a previous page. Opaque to the caller. */
  cursor?: string;
  /** Page size from 1 to 200. Defaults to 50. */
  limit?: number;
};

/** One page of tracked channels, newest first. */
export type ChannelPage = {
  /** The channels in this page, ordered by `openedAt` and then id, both descending. */
  channels: readonly Channel[];
  /** Pass as `cursor` for the next page; absent when this is the last page. */
  nextCursor?: string;
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
  /** Read-only, filtered, paginated view of every tracked channel. */
  listChannels(filter?: ChannelListFilter): Promise<ChannelPage>;
  shouldClose(channelId: string): Promise<boolean>;
  close(channelId: string): Promise<CloseResult>;
  /**
   * Finishes a close that a crash or an unknown outcome left in `closing`
   * (#176), deciding from the chain what happened:
   *
   * - no close on chain: the close is submitted again (`reclosed`);
   * - closed with nothing left in the contract: the settlement is looked up
   *   and recorded (`closed`), or `SettlementNotFoundError` is thrown and
   *   the channel stays `closing`;
   * - closed with funds left: a funder-started close or a dispute, handed to
   *   recovery (#38) as `recovering`.
   *
   * A settlement that differs from the last commitment moves the channel to
   * `settlement-mismatched` and throws `SettlementMismatchError`. A channel
   * that is not `closing` is left alone (`no-change`).
   *
   * Calling it again after it finished changes nothing, and concurrent calls
   * for one channel in one process share a single run, so at most one close
   * is submitted. Two processes over a shared store can still both submit
   * until the store offers compare-and-set (#175): run `resume` from one
   * process at a time until then.
   */
  resume(channelId: string): Promise<ResumeOutcome>;
  /**
   * Resumes every channel in `closing` and reports each result, including
   * the error for a channel that could not be resumed. One failure never
   * stops the others.
   */
  resumeAll(): Promise<ResumeAllResult>;
  recover(channelId: string): Promise<RecoveryResult>;
}

/**
 * What `resume` did (#176). `closed` recorded a settlement found on chain;
 * `reclosed` submitted a close again because none had landed; `recovering`
 * handed the channel to the recovery path (#38); `no-change` means the
 * channel was not `closing`.
 */
export type ResumeOutcome =
  | { kind: "closed"; channelId: string; settlementTxHash: string; returnedRemainder: string }
  | { kind: "recovering"; channelId: string; closeEffectiveAtLedger: number }
  | { kind: "reclosed"; channelId: string; settlementTxHash: string; returnedRemainder: string }
  | { kind: "no-change"; channelId: string; status: ChannelStatus };

export type ResumeAllResult = {
  outcomes: ReadonlyArray<ResumeOutcome | { kind: "error"; channelId: string; error: Error }>;
};
