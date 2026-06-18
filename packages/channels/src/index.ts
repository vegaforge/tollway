/**
 * @tollway/channels
 *
 * The MPP payment channel lifecycle the raw SDK leaves to the integrator:
 * open the channel, advance cumulative commitments off chain, close with a
 * single settlement, and recover when a counterparty goes quiet. See
 * docs/design.md, "The channel lifecycle manager".
 *
 * This release ships `open` and `commit`. `close` and `recover` are tracked
 * under #34 and #38 and remain typed stubs.
 */

export type {
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
export {
  ChannelNotFoundError,
  ChannelNotOpenError,
  CommitmentExceedsDepositError,
  InvalidAmountError,
} from "./errors.js";
export { type CreateChannelManagerOptions, createChannelManager } from "./manager.js";
export { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
export type {
  Channel,
  ChannelManager,
  ChannelStatus,
  ClosePolicy,
  CloseResult,
  Commitment,
  OpenChannelInput,
  RecoveryResult,
} from "./types.js";
