import { TollwayError } from "@tollway/core";

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
