import { z } from "zod";
import { TollwayError } from "./errors.js";
import { settlementModels } from "./types.js";

/**
 * The decision log the policy engine produces for every payment intent: one
 * entry per rule, in evaluation order, whether the rule passed, failed, or
 * did not apply. `check()` and the client both derive their decision from
 * this trace, so the explanation and the decision cannot disagree. See
 * apps/web/src/content/docs/policy.mdx, "Decision traces".
 *
 * The shape is versioned. A consumer that stores traces (the policy store,
 * the dashboard policy editor) parses them with `policyTraceSchema` and
 * rejects a version it does not know. Amounts and counts are integer
 * strings, the same convention as receipts.
 */
export const POLICY_TRACE_VERSION = 1;

export const policyModes = ["enforce", "dry-run"] as const;
/**
 * `enforce` blocks a payment when a rule fails. `dry-run` evaluates every
 * rule the same way but allows the payment, so a new policy can be watched
 * against real traffic before it is trusted. Enforce is the default.
 */
export type PolicyMode = (typeof policyModes)[number];

/**
 * Every rule the engine evaluates, in evaluation order. Static checks on the
 * intent come first, then the stateful budgets and windows.
 */
export const policyRuleIds = [
  "per-model-disabled",
  "min-channel-deposit",
  "budget-daily",
  "budget-total",
  "per-service",
  "rate-limit",
  "anomaly",
] as const;
export type PolicyRuleId = (typeof policyRuleIds)[number];

/**
 * The rule name `check()` and `PolicyBlockedError` report. It predates the
 * trace: both budget rules report `budget`, so the trace keeps the finer `id`
 * and the coarser `rule` side by side instead of renaming a public value.
 */
export const policyRuleNames = [
  "per-model-disabled",
  "min-channel-deposit",
  "budget",
  "per-service",
  "rate-limit",
  "anomaly",
] as const;
export type PolicyRuleName = (typeof policyRuleNames)[number];

export const policyOutcomes = ["pass", "fail", "not-applicable"] as const;
export type PolicyOutcome = (typeof policyOutcomes)[number];

const integerString = z.string().regex(/^[0-9]+$/, "must be an integer string");

/**
 * The period a stateful rule counts over. `utc-day` names the day the
 * counter belongs to, `lifetime` never resets, and `sliding` covers the last
 * `seconds` seconds up to the evaluation time.
 */
export const policyWindowSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("utc-day"), day: z.iso.date() }),
  z.strictObject({ kind: z.literal("lifetime") }),
  z.strictObject({ kind: z.literal("sliding"), seconds: z.number().int().positive() }),
]);
export type PolicyWindow = z.infer<typeof policyWindowSchema>;

export const policyTraceEntrySchema = z.strictObject({
  id: z.enum(policyRuleIds),
  rule: z.enum(policyRuleNames),
  /** True when the policy sets this rule at all, whether or not it covers this intent. */
  configured: z.boolean(),
  outcome: z.enum(policyOutcomes),
  /** The configured limit, or null for a rule without one (a disabled model). */
  limit: integerString.nullable(),
  /** The counter before this payment, or null for a rule that keeps no counter. */
  current: integerString.nullable(),
  /** The value the limit is compared with if this payment goes through. */
  projected: integerString.nullable(),
  window: policyWindowSchema.nullable(),
  /** One sentence for a person reading the log. */
  detail: z.string().min(1),
});
export type PolicyTraceEntry = z.infer<typeof policyTraceEntrySchema>;

export const policyTraceSchema = z
  .strictObject({
    version: z.literal(POLICY_TRACE_VERSION),
    mode: z.enum(policyModes),
    evaluatedAt: z.iso.datetime(),
    // The intent fields only. Request bodies and headers never enter a trace.
    intent: z.strictObject({
      payee: z.string().min(1),
      resource: z.string().min(1),
      amount: integerString,
      asset: z.string().min(1),
      model: z.enum(settlementModels),
    }),
    /** The decision after the mode is applied. Always true in dry-run. */
    allowed: z.boolean(),
    /** True when at least one rule failed, whatever the mode. */
    wouldBlock: z.boolean(),
    /** The first failing rule in evaluation order, the one enforce mode reports. */
    blockedBy: z.enum(policyRuleIds).nullable(),
    entries: z.array(policyTraceEntrySchema),
  })
  .superRefine((trace, ctx) => {
    // The summary fields are derived from the entries. A stored trace whose
    // summary contradicts its own entries is corrupt, not merely odd.
    const firstFail = trace.entries.find((entry) => entry.outcome === "fail");
    if (trace.wouldBlock !== (firstFail !== undefined)) {
      ctx.addIssue({ code: "custom", message: "wouldBlock does not match the entries" });
    }
    if (trace.blockedBy !== (firstFail?.id ?? null)) {
      ctx.addIssue({ code: "custom", message: "blockedBy is not the first failing entry" });
    }
    const expectedAllowed = trace.mode === "dry-run" || !trace.wouldBlock;
    if (trace.allowed !== expectedAllowed) {
      ctx.addIssue({ code: "custom", message: "allowed does not match the mode and entries" });
    }
  });
export type PolicyTrace = z.infer<typeof policyTraceSchema>;

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; rule: PolicyRuleName; detail: string };

/**
 * The one place a trace turns into a decision. `check()` uses it and so does
 * the client, which is what keeps the decision and its explanation in step.
 */
export function decisionFromTrace(trace: PolicyTrace): PolicyDecision {
  if (trace.allowed) return { allowed: true };
  const failing = trace.entries.find((entry) => entry.outcome === "fail");
  if (failing === undefined) {
    // The engine never builds such a trace, but a hand-made or corrupted one
    // could. Throwing blocks the payment without inventing a rule to blame.
    throw new TollwayError("invalid-policy", "policy trace blocks without a failing rule");
  }
  return { allowed: false, rule: failing.rule, detail: failing.detail };
}

/** One rule whose outcome differs between the active and the candidate policy. */
export type PolicyTraceDifference = {
  id: PolicyRuleId;
  active: PolicyOutcome;
  candidate: PolicyOutcome;
};

export type PolicyTraceComparison = {
  /** True when the two policies would block or allow this intent alike. */
  sameDecision: boolean;
  activeWouldBlock: boolean;
  candidateWouldBlock: boolean;
  differences: PolicyTraceDifference[];
};

/**
 * Compares the would-block result of two traces for the same intent, rule
 * by rule. Modes are ignored on purpose: a shadow comparison asks what each
 * policy would decide if enforced, not what the active mode happens to be.
 */
export function comparePolicyTraces(
  active: PolicyTrace,
  candidate: PolicyTrace,
): PolicyTraceComparison {
  const activeOutcomes = new Map(active.entries.map((entry) => [entry.id, entry.outcome]));
  const candidateOutcomes = new Map(candidate.entries.map((entry) => [entry.id, entry.outcome]));
  const differences: PolicyTraceDifference[] = [];
  for (const id of policyRuleIds) {
    // A rule missing from a trace (a trace from an older engine) reads as
    // not-applicable, which is what an absent rule means.
    const a = activeOutcomes.get(id) ?? "not-applicable";
    const c = candidateOutcomes.get(id) ?? "not-applicable";
    if (a !== c) differences.push({ id, active: a, candidate: c });
  }
  return {
    sameDecision: active.wouldBlock === candidate.wouldBlock,
    activeWouldBlock: active.wouldBlock,
    candidateWouldBlock: candidate.wouldBlock,
    differences,
  };
}
