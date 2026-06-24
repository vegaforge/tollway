/**
 * @tollway/server
 *
 * The service-side gate that charges agents, framework agnostic. Framework
 * adapters (Express, Fastify, Next, Hono) wrap the gate; this package owns
 * the payment logic. See docs/design.md, "Architecture" (service side).
 */

export { createInMemorySettlementCache, type SettlementCache } from "./cache.js";
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
  type PaywallConfig,
  type PaywallDeps,
  type TollwayRequest,
} from "./gate.js";
export {
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
} from "./headers.js";
export {
  createMockMppChargeHandler,
  createMppChargeHandler,
  deriveMppChargeNonce,
  type MppChargeHandler,
  type MppChargeOptions,
  type MppChargeSettleInput,
  type MppChargeSettleResult,
  type MppChargeVerifyInput,
  type MppChargeVerifyResult,
} from "./mpp-charge.js";
