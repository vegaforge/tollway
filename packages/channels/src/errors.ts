import { type QuarantineEntry, TollwayError } from "@vegaforge/tollway-core";

/** Thrown when a channel id is not tracked by the manager. */
export class ChannelNotFoundError extends TollwayError {
  readonly channelId: string;

  constructor(channelId: string) {
    super("channel-not-found", `channel "${channelId}" is not tracked by this manager`);
    this.name = "ChannelNotFoundError";
    this.channelId = channelId;
  }
}

/** Thrown when a commit would advance the cumulative beyond the channel deposit. */
export class CommitmentExceedsDepositError extends TollwayError {
  readonly channelId: string;
  readonly attemptedCumulative: string;
  readonly deposit: string;

  constructor(channelId: string, attemptedCumulative: string, deposit: string) {
    super(
      "commitment-exceeds-deposit",
      `commit on channel "${channelId}" would advance cumulative to ${attemptedCumulative}, ` +
        `which exceeds the channel deposit of ${deposit}`,
    );
    this.name = "CommitmentExceedsDepositError";
    this.channelId = channelId;
    this.attemptedCumulative = attemptedCumulative;
    this.deposit = deposit;
  }
}

/**
 * Thrown by a `CommitmentStore` compare-and-set when the state it holds is
 * not the state the caller expected, so another writer got there first
 * (#175). `field` says which part lost: the channel's `sequence` or its
 * `status`. The write was not applied, and nothing partial is visible.
 */
export class CommitmentConflictError extends TollwayError {
  readonly channelId: string;
  readonly field: "sequence" | "status";
  readonly expected: string;
  readonly actual: string;

  constructor(channelId: string, field: "sequence" | "status", expected: string, actual: string) {
    super(
      "commitment-conflict",
      `channel "${channelId}" ${field} is "${actual}", not the expected "${expected}"; another writer changed it first`,
    );
    this.name = "CommitmentConflictError";
    this.channelId = channelId;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown when an amount string is not a non-negative integer. */
export class InvalidAmountError extends TollwayError {
  constructor(value: string, field: string) {
    super("invalid-amount", `${field} "${value}" is not a valid non-negative integer string`);
    this.name = "InvalidAmountError";
  }
}

/** Thrown when a commit is attempted on a channel that is not open. */
export class ChannelNotOpenError extends TollwayError {
  readonly channelId: string;
  readonly status: string;

  constructor(channelId: string, status: string) {
    super(
      "channel-not-open",
      `channel "${channelId}" is in status "${status}"; commit requires status "open"`,
    );
    this.name = "ChannelNotOpenError";
    this.channelId = channelId;
    this.status = status;
  }
}

/** Thrown when close is attempted on a channel that is already closing, closed, or in recovery. */
export class ChannelAlreadyClosedError extends TollwayError {
  readonly channelId: string;
  readonly status: string;

  constructor(channelId: string, status: string) {
    super(
      "channel-already-closed",
      `channel "${channelId}" cannot be closed from status "${status}"; close requires status "open"`,
    );
    this.name = "ChannelAlreadyClosedError";
    this.channelId = channelId;
    this.status = status;
  }
}

/**
 * Thrown when the on-chain settlement reports an amount that is inconsistent
 * with the latest cumulative commitment recorded off chain. This is the
 * manager's last-line check that the adapter delivered what was asked for.
 */
export class SettlementMismatchError extends TollwayError {
  readonly channelId: string;
  readonly expectedSettled: string;
  readonly actualSettled: string;

  constructor(channelId: string, expectedSettled: string, actualSettled: string) {
    super(
      "settlement-mismatch",
      `channel "${channelId}" settled ${actualSettled} but the last commitment was ${expectedSettled}`,
    );
    this.name = "SettlementMismatchError";
    this.channelId = channelId;
    this.expectedSettled = expectedSettled;
    this.actualSettled = actualSettled;
  }
}

/**
 * Thrown by a settlement lookup that cannot see back to the ledger a close
 * attempt started at: the RPC provider keeps events only for a limited
 * window, or the scan hit its bound. "Nothing found" would be a guess, so
 * `resume` fails loudly and leaves the channel in `closing` for an operator.
 */
export class MissingEventHistoryError extends TollwayError {
  readonly channelId: string;
  readonly startLedger: number;

  constructor(channelId: string, startLedger: number, detail?: string) {
    super(
      "settlement-mismatch",
      `channel "${channelId}": the settlement lookup cannot see back to ledger ${startLedger}: ${
        detail ?? "the RPC no longer keeps events that old"
      }`,
    );
    this.name = "MissingEventHistoryError";
    this.channelId = channelId;
    this.startLedger = startLedger;
  }
}

/**
 * Thrown by an adapter's `closeChannel` when it failed before submitting
 * anything, for example on a malformed commitment. It is the only adapter
 * error after which the manager returns the channel to `open`: any other
 * failure may have reached the chain, so the channel stays `closing` for
 * `resume` (issue #176). `cause` carries the underlying error, and its code
 * is kept, so a caller branching on `code` still sees the reason.
 */
export class CloseNotSubmittedError extends TollwayError {
  readonly channelId: string;

  constructor(channelId: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      cause instanceof TollwayError ? cause.code : "payment-failed",
      `channel "${channelId}" close was not submitted: ${reason}`,
      { cause },
    );
    this.name = "CloseNotSubmittedError";
    this.channelId = channelId;
  }
}

/**
 * Thrown by `resume` when the chain reports the close as settled but the
 * settlement transaction cannot be found. The channel stays `closing`: it
 * must not be marked `closed` without the transaction hash and remainder.
 */
export class SettlementNotFoundError extends TollwayError {
  readonly channelId: string;
  readonly startLedger: number;

  constructor(channelId: string, startLedger: number) {
    super(
      "settlement-mismatch",
      `channel "${channelId}" is closed on chain, but no settlement was found from ledger ${startLedger}`,
    );
    this.name = "SettlementNotFoundError";
    this.channelId = channelId;
    this.startLedger = startLedger;
  }
}

/** Thrown when open or commit is attempted for a quarantined counterparty. */
export class CounterpartyQuarantinedError extends TollwayError {
  readonly counterparty: string;
  readonly reason: string;
  readonly entry?: QuarantineEntry;

  constructor(
    counterparty: string,
    reason: string,
    options?: { entry?: QuarantineEntry; cause?: unknown },
  ) {
    super(
      "counterparty-quarantined",
      `counterparty "${counterparty}" is quarantined: ${reason}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "CounterpartyQuarantinedError";
    this.counterparty = counterparty;
    this.reason = reason;
    this.entry = options?.entry;
  }
}
