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
  createHttpFacilitator,
  createMockFacilitator,
  type FacilitatorClient,
  type SettleInput,
  type SettleResult,
  type SupportedResult,
  type VerifyInput,
  type VerifyResult,
} from "./facilitator.js";
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
  encodeHeader,
  MPP_AUTHORIZATION_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
  readMppCredential,
  TOLLWAY_QUOTE_HEADER,
} from "./headers.js";
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
