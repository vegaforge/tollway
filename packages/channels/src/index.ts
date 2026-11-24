/**
 * @vegaforge/tollway-channels
 *
 * The MPP payment channel lifecycle the raw SDK leaves to the integrator:
 * open the channel, advance cumulative commitments off chain, close with a
 * single settlement, and recover when a counterparty goes quiet. See
 * docs/design.md, "The channel lifecycle manager".
 *
 * This release ships `open`, `commit`, `shouldClose`, `close`, `resume`,
 * `resumeAll` and `recover`, plus `createStellarMppChannelAdapter`, the
 * adapter backed by @stellar/mpp. The funder-side contract calls behind
 * `startClose` and `refund` are the adapter's follow-up (#101).
 */

export type {
  ChannelChainState,
  ChannelState,
  CloseAdapterInput,
  CloseAdapterResult,
  FoundChannelSettlement,
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  RefundResult,
  SignCommitmentInput,
  SignedCommitment,
  StartCloseResult,
} from "./adapter.js";
export {
  ChannelAlreadyClosedError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  CloseNotSubmittedError,
  CommitmentExceedsDepositError,
  CounterpartyQuarantinedError,
  InvalidAmountError,
  MissingEventHistoryError,
  RecoveryNotYetEffectiveError,
  SettlementMismatchError,
  SettlementNotFoundError,
} from "./errors.js";
export { type CreateChannelManagerOptions, createChannelManager } from "./manager.js";
export {
  createStellarMppChannelAdapter,
  type StellarMppChannelAdapterOptions,
} from "./stellar-adapter.js";
export { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
export type {
  Channel,
  ChannelManager,
  ChannelStatus,
  ClosePolicy,
  CloseResult,
  Commitment,
  OpenChannelInput,
  RecoveryEvent,
  RecoveryResult,
  ResumeAllResult,
  ResumeOutcome,
} from "./types.js";
