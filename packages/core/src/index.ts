/**
 * @vegaforge/tollway-core
 *
 * The shared foundation everything else composes: domain types, the
 * canonical signed receipt, the model router interface, and the policy
 * schema. The architecture this implements is described in docs/design.md.
 */

export { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "./encoding.js";
export { NotImplementedError, TollwayError, type TollwayErrorCode } from "./errors.js";
export {
  createPolicyEngine,
  type AdaptiveAnomalyEvent,
  type PaymentIntent,
  type Policy,
  type PolicyEngine,
} from "./policy.js";
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
export { canonicalBytes, canonicalJson, type JsonValue } from "./receipt/canonical.js";
export {
  checkSmartAccountPolicy,
  planSmartAccountPolicy,
  type InstalledSpendingLimit,
  type SmartAccountCheck,
  type SmartAccountConstraint,
  type SmartAccountInvocation,
  type SmartAccountPlan,
  type SmartAccountPlannerOptions,
  type SmartAccountPolicyReader,
  type SmartAccountResidual,
} from "./smart-account-policy.js";
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
