/**
 * @vegaforge/tollway-channels
 *
 * The MPP payment channel lifecycle the raw SDK leaves to the integrator:
 * open the channel, advance cumulative commitments off chain, close with a
 * single settlement, and recover when a counterparty goes quiet. See
 * docs/design.md, "The channel lifecycle manager".
 *
 * This release ships `open`, `commit`, `listChannels`, `shouldClose`, `close`,
 * `resume` and `resumeAll`, and `createStellarMppChannelAdapter`, the adapter
 * backed by @stellar/mpp.
 * `recover` is tracked under #38 and remains a typed stub.
 */

export type {
  ChannelChainState,
  CloseAdapterInput,
  CloseAdapterResult,
  FoundChannelSettlement,
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
export {
  ChannelAlreadyClosedError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  CloseNotSubmittedError,
  CommitmentConflictError,
  CommitmentExceedsDepositError,
  CounterpartyQuarantinedError,
  InvalidAmountError,
  MissingEventHistoryError,
  SettlementMismatchError,
  SettlementNotFoundError,
} from "./errors.js";
export {
  type ChannelClosedEvent,
  type ChannelCloseFailedEvent,
  type ChannelClosingEvent,
  type ChannelEventHandler,
  type ChannelEventSink,
  type ChannelLifecycleEvent,
  type ChannelOpenedEvent,
  type ObservabilityBridge,
  toObservabilitySink,
} from "./events.js";
export { type CreateChannelManagerOptions, createChannelManager } from "./manager.js";
export {
  RATE_PRECISION,
  type SizeDepositDecision,
  type SizeDepositInput,
  sizeDeposit,
} from "./sizing.js";
export {
  createStellarMppChannelAdapter,
  type StellarMppChannelAdapterOptions,
} from "./stellar-adapter.js";
export {
  type CommitmentAppendExpectation,
  type CommitmentStore,
  createMemoryCommitmentStore,
} from "./store.js";
export {
  createPostgresCommitmentStore,
  type PostgresClient,
  type PostgresCommitmentStoreOptions,
  type PostgresConnection,
  type PostgresQueryable,
  type PostgresQueryResult,
} from "./stores/postgres.js";
export {
  createRedisCommitmentStore,
  type RedisCommitmentStoreOptions,
  type RedisLikeClient,
} from "./stores/redis.js";
export type {
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
