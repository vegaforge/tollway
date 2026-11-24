/**
 * @vegaforge/tollway-core
 *
 * The shared foundation everything else composes: domain types, the
 * canonical signed receipt, the model router interface, and the policy
 * schema. The architecture this implements is described in docs/design.md.
 */

export { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "./encoding.js";
export {
  ChannelOpenFailedError,
  type ChannelOpenSubmission,
  NotImplementedError,
  TollwayError,
  type TollwayErrorCode,
} from "./errors.js";
export {
  type AdaptiveAnomalyEvent,
  type ChannelOpenDecision,
  type ChannelOpenIntent,
  type ChannelOpenRule,
  createPolicyEngine,
  type PaymentIntent,
  type PolicyEngine,
  type PolicyHeadroom,
} from "./policy.js";
export {
  formatPolicyIssues,
  POLICY_SCHEMA_ID,
  POLICY_VERSION,
  type Policy,
  type PolicyInput,
  type PolicyIssue,
  type PolicyParseResult,
  PolicyValidationError,
  parsePolicy,
  policyJsonSchema,
  policySchema,
} from "./policy-schema.js";
export {
  comparePolicyTraces,
  decisionFromTrace,
  POLICY_TRACE_VERSION,
  type PolicyDecision,
  type PolicyMode,
  type PolicyOutcome,
  type PolicyRuleId,
  type PolicyRuleName,
  type PolicyTrace,
  type PolicyTraceComparison,
  type PolicyTraceDifference,
  type PolicyTraceEntry,
  type PolicyWindow,
  policyModes,
  policyOutcomes,
  policyRuleIds,
  policyRuleNames,
  policyTraceEntrySchema,
  policyTraceSchema,
  policyWindowSchema,
} from "./policy-trace.js";
export {
  type CounterpartyQuarantine,
  type CreateMemoryQuarantineOptions,
  createMemoryQuarantine,
  type QuarantineDrift,
  type QuarantineEntry,
  type QuarantineInput,
  type ReleaseQuarantineInput,
} from "./quarantine.js";
export { canonicalBytes, canonicalJson, type JsonValue } from "./receipt/canonical.js";
export {
  derToP1363,
  ECDSA_P256_ALG,
  EcdsaP256Signer,
  EcdsaP256Verifier,
  normaliseLowS,
  type P256PublicJwk,
  p1363ToBase64Url,
} from "./receipt/ecdsa.js";
export {
  createKeySetVerifier,
  ed25519KeyEntrySchema,
  type KeySetDocument,
  type KeySetEntry,
  type KeySetFetcher,
  type KeySetVerifier,
  type KeySetVerifierOptions,
  keySetDocumentSchema,
  keySetEntrySchema,
  p256KeyEntrySchema,
  parseKeySetDocument,
  RECEIPT_ALGORITHMS,
  type ReceiptAlgorithm,
} from "./receipt/key-set.js";
export {
  type BuildReceiptInput,
  buildReceipt,
  hashOffer,
  type ReceiptVerification,
  signReceipt,
  type VerifyReceiptOptions,
  verifyReceipt,
} from "./receipt/receipt.js";
export {
  type ReceiptBody,
  type ReceiptBodyV1,
  type ReceiptBodyV2,
  type ReceiptSignature,
  receiptBodySchema,
  receiptBodyV1Schema,
  receiptBodyV2Schema,
  receiptSignatureSchema,
  type SettlementRef,
  type SignedReceipt,
  settlementRefSchema,
  signedReceiptSchema,
} from "./receipt/schema.js";
export {
  Ed25519Signer,
  Ed25519Verifier,
  type PublicJwk,
  type ReceiptSigner,
  type ReceiptVerifier,
  type SignatureCheck,
  type SignatureInput,
} from "./receipt/signer.js";
export { RollingSum, type RollingSumOptions } from "./rolling-sum.js";
export {
  createDefaultRouter,
  type DefaultRouterOptions,
  type ModelRouter,
  type RouteDecision,
  type RouteInput,
  type RouteReason,
  type TrafficSnapshot,
} from "./router.js";
export {
  checkSmartAccountPolicy,
  type InstalledSpendingLimit,
  planSmartAccountPolicy,
  type SmartAccountCheck,
  type SmartAccountConstraint,
  type SmartAccountInvocation,
  type SmartAccountPlan,
  type SmartAccountPlannerOptions,
  type SmartAccountPolicyReader,
  type SmartAccountResidual,
} from "./smart-account-policy.js";
export type { SponsorBalanceReading, SponsorLowBalanceEvent } from "./sponsor.js";
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
