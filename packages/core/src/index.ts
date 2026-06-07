/**
 * @tollway/core
 *
 * The shared foundation everything else composes: domain types, the
 * canonical signed receipt, the model router interface, and the policy
 * schema. The architecture this implements is described in docs/design.md.
 */

export { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "./encoding.js";
export { NotImplementedError, TollwayError, type TollwayErrorCode } from "./errors.js";
export {
  createPolicyEngine,
  type PaymentIntent,
  type Policy,
  type PolicyDecision,
  type PolicyEngine,
} from "./policy.js";
export { canonicalBytes, canonicalJson, type JsonValue } from "./receipt/canonical.js";
export {
  type BuildReceiptInput,
  buildReceipt,
  type ReceiptVerification,
  signReceipt,
  verifyReceipt,
} from "./receipt/receipt.js";
export {
  type ReceiptBody,
  type ReceiptSignature,
  receiptBodySchema,
  receiptSignatureSchema,
  type SettlementRef,
  type SignedReceipt,
  settlementRefSchema,
  signedReceiptSchema,
} from "./receipt/schema.js";
export {
  Ed25519Signer,
  Ed25519Verifier,
  type ReceiptSigner,
  type ReceiptVerifier,
} from "./receipt/signer.js";
export {
  createDefaultRouter,
  type ModelRouter,
  type RouteDecision,
  type RouteInput,
  type RouteReason,
  type TrafficSnapshot,
} from "./router.js";
export {
  type MppChannelPayment,
  type MppChargePayment,
  type PaymentOffer,
  type PaymentPayload,
  type SettlementModel,
  type StellarNetwork,
  settlementModels,
  stellarNetworks,
  type X402Payment,
} from "./types.js";
