import { TollwayError } from "@tollway/core";

/** Thrown when a channel id is not tracked by the manager. */
export class ChannelNotFoundError extends TollwayError {
  readonly channelId: string;

  constructor(channelId: string) {
    super("invalid-amount", `channel "${channelId}" is not tracked by this manager`);
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
      "invalid-amount",
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
      "invalid-amount",
      `channel "${channelId}" is in status "${status}"; commit requires status "open"`,
    );
    this.name = "ChannelNotOpenError";
    this.channelId = channelId;
    this.status = status;
  }
}
