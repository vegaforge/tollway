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
  type Gate,
  type GateOutcome,
  type DynamicPriceFunction,
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
  TOLLWAY_QUOTE_HEADER,
  readHeader,
  readMppCredential,
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
  createChannelWatchtower,
  createStellarChannelWatchRpc,
  type ChannelDispute,
  type ChannelLoss,
  type ChannelWatchRegistry,
  type ChannelWatchRpc,
  type ChannelWatchSettlement,
  type ChannelWatchtower,
  type CreateChannelWatchtowerOptions,
  type WatchtowerChannel,
} from "./channel-watchtower.js";
export {
  createRouteTable,
  type RouteTable,
  type RouteTableEntry,
  type RouteTableMatch,
} from "./route-table.js";
