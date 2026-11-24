/**
 * @vegaforge/tollway-server
 *
 * The service-side gate that charges agents, framework agnostic. Framework
 * adapters (Express, Fastify, Next, Hono) wrap the gate; this package owns
 * the payment logic. See docs/design.md, "Architecture" (service side).
 */

export {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type InMemorySettlementCacheOptions,
  type LockingSettlementCache,
  type RedisLikeClient,
  type RedisSettlementCacheOptions,
  type SettlementCache,
  type SettlementEntry,
  type SettlementLock,
} from "./cache.js";
export {
  type ChannelDispute,
  type ChannelLoss,
  type ChannelWatchRegistry,
  type ChannelWatchRpc,
  type ChannelWatchSettlement,
  type ChannelWatchtower,
  type CreateChannelWatchtowerOptions,
  createChannelWatchtower,
  createStellarChannelWatchRpc,
  type WatchtowerChannel,
} from "./channel-watchtower.js";
export {
  type DiscoveryCatalogue,
  type DiscoveryDeclaration,
  listDiscoveryResources,
} from "./discovery.js";
export {
  createHttpFacilitator,
  createMockFacilitator,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  type FacilitatorClient,
  type SettleInput,
  type SettleResult,
  STELLAR_EXACT_SCHEME,
  stellarCaip2,
  toPaymentRequirements,
  type VerifyInput,
  type VerifyResult,
  type X402Terms,
} from "./facilitator.js";
export {
  createFacilitatorValidator,
  describeMismatches,
  type FacilitatorCapabilities,
  FacilitatorCheckError,
  type FacilitatorCheckReport,
  type FacilitatorKind,
  type FacilitatorValidator,
  type FacilitatorValidatorOptions,
  findMatchingKind,
  type PaywallMismatch,
  type PaywallTarget,
  type PaywallValidation,
  parseFacilitatorCapabilities,
  type ValidationMode,
  validatePaywall,
} from "./facilitator-capabilities.js";
export {
  createFailoverFacilitator,
  createMemoryPinStore,
  type FailoverEvent,
  type FailoverFacilitatorOptions,
  type FailoverMember,
  type SettlementPinStore,
} from "./failover-facilitator.js";
export {
  createPaywall,
  type DynamicPriceFunction,
  type Gate,
  type GateOutcome,
  type PaywallConfig,
  type PaywallDeps,
  type TollwayRequest,
} from "./gate.js";
export {
  decodeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  MPP_AUTHORIZATION_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
  readMppCredential,
  TOLLWAY_QUOTE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./headers.js";
export {
  type KeySetResponse,
  type KeySetResponseOptions,
  renderKeySetResponse,
} from "./key-set-response.js";
export {
  createMockMppChargeHandler,
  createMppChargeHandler,
  deriveMppChargeNonce,
  type MppChargeChallenge,
  type MppChargeChallengeInput,
  type MppChargeHandler,
  type MppChargeOptions,
  type MppChargeSettleInput,
  type MppChargeSettleResult,
  type MppChargeVerifyInput,
  type MppChargeVerifyResult,
} from "./mpp-charge.js";
export {
  createRouteTable,
  type RouteTable,
  type RouteTableEntry,
  type RouteTableMatch,
} from "./route-table.js";
export {
  createInMemoryServicePolicyStore,
  type InMemoryServicePolicyStoreOptions,
  SERVICE_POLICY_DENIALS,
  type ServicePolicy,
  type ServicePolicyDecision,
  type ServicePolicyDenialCode,
  type ServicePolicyInput,
  type ServicePolicyReservation,
  type ServicePolicyStore,
  validateServicePolicy,
} from "./service-policy.js";
export {
  createHorizonSponsorBalanceReader,
  createSponsorMonitor,
  type SponsorBalanceReader,
  type SponsorHorizonClient,
  type SponsorMonitor,
  type SponsorMonitorOptions,
  type SponsorMonitorSink,
} from "./sponsor-monitor.js";
