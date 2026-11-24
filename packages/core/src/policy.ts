import { TollwayError } from "./errors.js";
import {
  type Policy,
  type PolicyInput,
  PolicyValidationError,
  parsePolicy,
} from "./policy-schema.js";
import {
  decisionFromTrace,
  POLICY_TRACE_VERSION,
  type PolicyDecision,
  type PolicyMode,
  type PolicyTrace,
  type PolicyTraceEntry,
  type PolicyWindow,
} from "./policy-trace.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { RollingSum } from "./rolling-sum.js";
import type { SettlementModel } from "./types.js";

// Re-exported so existing `import type { Policy } from "./policy.js"` keeps working.
export type { Policy, PolicyInput } from "./policy-schema.js";

/** A payment the engine is asked to allow or block, before it happens. */
export type PaymentIntent = {
  payee: string;
  resource: string;
  amount: string;
  asset: string;
  model: SettlementModel;
};

/**
 * A channel the caller is about to open (#181). The deposit is what the
 * channel locks, as an integer string in the asset's base units.
 */
export type ChannelOpenIntent = {
  /** The counterparty the channel pays. Keys the per-service cap. */
  payee: string;
  asset: string;
  deposit: string;
};

/**
 * A rule that can block a channel open. The two spend ceilings are the rules
 * the headroom query reports on.
 */
export type ChannelOpenRule =
  | "min-channel-deposit"
  | "budget-daily"
  | "budget-total"
  | "per-service"
  | "per-service-daily"
  | "per-service-window";

/** What {@link PolicyEngine.evaluateChannelOpen} decided. Does not record spend. */
export type ChannelOpenDecision = {
  /** False when a rule blocks the open in enforce mode. Dry-run never blocks. */
  allowed: boolean;
  /** True when a rule would block the open, in either mode. */
  wouldBlock: boolean;
  /** The first rule that blocks the open, or null when none does. */
  rule: ChannelOpenRule | null;
  /** Says why, in words fit for a log line. */
  detail: string;
};

/**
 * How much an agent may still spend with one payee in one asset (#181).
 * `headroom` is the smallest remaining amount across the spend ceilings that
 * apply, as an integer string, and `limitedBy` names that ceiling. Both are
 * null when the policy sets no ceiling for this asset and payee.
 */
export type PolicyHeadroom = {
  asset: string;
  payee: string;
  headroom: string | null;
  limitedBy: Exclude<ChannelOpenRule, "min-channel-deposit"> | null;
};

/**
 * Spending rules an agent applies before it pays. {@link createPolicyEngine}
 * builds one from a policy.
 */
export interface PolicyEngine {
  /** The mode the engine was created with. The client warns when it is dry-run. */
  readonly mode: PolicyMode;
  /**
   * Evaluates every rule against the intent and returns the full trace,
   * including the decision. Does not record spend.
   */
  evaluate(intent: PaymentIntent): Promise<PolicyTrace>;
  /** The decision alone, derived from `evaluate` with `decisionFromTrace`. */
  check(intent: PaymentIntent): Promise<PolicyDecision>;
  /**
   * Evaluates the intent for a payment the caller is about to make and,
   * when the trace allows it, counts it as one attempt toward a rate limit
   * with `count: "attempts"`. Evaluating and counting are one step, so
   * concurrent attempts cannot all pass the last free slot. The client
   * calls this once per payment it sends, including each retry with a
   * fresh authorization. Optional, so engines written before issue #197
   * still satisfy the interface; the client falls back to `evaluate`.
   */
  admit?(intent: PaymentIntent): Promise<PolicyTrace>;
  /**
   * Counts one attempt without evaluating. The client calls it on a shadow
   * engine when the active policy sent a payment, so the shadow's
   * attempt-counted limits see the same traffic. Never blocks anything.
   */
  recordAttempt?(intent: PaymentIntent): Promise<void>;
  /** Records a settled payment so budgets and anomaly windows advance. */
  record(intent: PaymentIntent): Promise<void>;
  /**
   * The spend room left for one asset and payee (#181). Read-only. Optional,
   * so engines written before this release still satisfy the interface.
   */
  headroom?(asset: string, payee: string): Promise<PolicyHeadroom>;
  /**
   * Checks a channel open's deposit against `minChannelDeposit` and the
   * headroom for its asset and payee (#181). Does not record spend, because
   * a deposit is not spend: unspent funds return to the funder on close.
   * Optional, like `headroom`.
   */
  evaluateChannelOpen?(open: ChannelOpenIntent): Promise<ChannelOpenDecision>;
}

export type AdaptiveAnomalyEvent = {
  type: "anomaly.detected";
  intent: PaymentIntent;
  detail: string;
};

const WINDOW_MS = 60_000;
const MINUTE_WINDOW: PolicyWindow = { kind: "sliding", seconds: WINDOW_MS / 1000 };
const LIFETIME: PolicyWindow = { kind: "lifetime" };

function utcDate(clock: () => number): string {
  return new Date(clock()).toISOString().slice(0, 10);
}

function parseAmount(s: string): bigint {
  if (!/^[0-9]+$/.test(s)) {
    throw new TollwayError("invalid-amount", `invalid amount: ${s}`);
  }
  return BigInt(s);
}

/** One spend ceiling for a payee and asset: its limit, and what is spent under it. */
type SpendCeilingLimit = {
  rule:
    | "budget-daily"
    | "budget-total"
    | "per-service"
    | "per-service-daily"
    | "per-service-window";
  limit: bigint;
  spent: bigint;
};

/** Spend and request history the stateful rules read. */
type EngineState = {
  day: string;
  dailySpend: Map<string, bigint>;
  totalSpend: Map<string, bigint>;
  serviceSpend: Map<string, bigint>;
  /**
   * Issue #192: per-service calendar-day spend, reset in
   * `resetDailyIfNeeded` alongside `dailySpend`.
   */
  serviceDailySpend: Map<string, bigint>;
  /**
   * Issue #192: per-service rolling-window spend. One `RollingSum` per
   * `${payee}:${asset}` key; idle keys with empty accumulators are
   * evicted at record time.
   */
  serviceWindowSpend: Map<string, RollingSum>;
  resourceSpend: Map<string, bigint>;
  resourceDailySpend: Map<string, bigint>;
  resourceWindowSpend: Map<string, RollingSum>;
  /** Issue #197: the rate limit's own log, independent of the anomaly window. */
  rateLimiter: RateLimiter | undefined;
  anomalySamples: { amount: bigint; asset: string; ts: number }[];
  adaptive: Map<string, AdaptiveState>;
};

type AdaptiveState = {
  bucketStart: number;
  bucketSpend: bigint;
  baseline: bigint | undefined;
  deviation: bigint;
  samples: number;
};

/** Everything one evaluation needs, computed once and shared by every rule. */
type RuleInput = {
  policy: Policy;
  intent: PaymentIntent;
  amount: bigint;
  now: number;
  state: EngineState;
};

type RuleEvaluator = (input: RuleInput) => PolicyTraceEntry;

function serviceKey(payee: string, asset: string): string {
  return `${payee}:${asset}`;
}

function resourceKey(resource: string, asset: string): string {
  return `${resource}:${asset}`;
}

type ResourceEntry = NonNullable<Policy["perResource"]>[string];

/** One `perResource` entry that applies to a resource, with the key it is stored under. */
type ResourceMatch = { key: string; entry: ResourceEntry };

/**
 * Every `perResource` entry that applies to a resource: the entry keyed by
 * the exact resource string, then every `prefix` entry whose key the
 * resource starts with, most specific first.
 *
 * All of them apply. Picking only the most specific entry would let a
 * narrow entry with a high cap lift a broader, stricter one, so spend under
 * `/api/quotes/` could exceed a cap the operator put on `/api/`. A cap must
 * never fail open.
 *
 * Matching is a plain string comparison: the resource identity includes any
 * query string, and the prefix `/api` also matches `/apix`.
 */
function matchResourceEntries(
  perResource: NonNullable<Policy["perResource"]>,
  resource: string,
): ResourceMatch[] {
  const matches: ResourceMatch[] = [];
  // Object.hasOwn, so a resource named "constructor" does not match a
  // member of Object.prototype.
  const exact = Object.hasOwn(perResource, resource) ? perResource[resource] : undefined;
  if (exact) {
    matches.push({ key: resource, entry: exact });
  }
  const prefixes: ResourceMatch[] = [];
  for (const [key, entry] of Object.entries(perResource)) {
    if (key === resource || entry?.match !== "prefix") continue;
    if (resource.startsWith(key)) {
      prefixes.push({ key, entry });
    }
  }
  prefixes.sort((a, b) => b.key.length - a.key.length);
  return [...matches, ...prefixes];
}

const FIXED_SCALE = 1_000_000n;

/**
 * `policySchema` already refuses a bad rational when the engine is created,
 * so this check and the ones in `adaptiveConfig` cannot fail through the
 * engine. They stay as defence in depth for the rules that read the values.
 */
function parseRational(
  value: { numerator: string; denominator: string },
  label: string,
): [bigint, bigint] {
  const numerator = parseAmount(value.numerator);
  const denominator = parseAmount(value.denominator);
  if (numerator <= 0n || denominator <= 0n) {
    throw new TollwayError("invalid-policy", `${label} must be a positive rational`);
  }
  return [numerator, denominator];
}

function adaptiveKey(intent: PaymentIntent, scope: "asset" | "asset-payee"): string {
  return scope === "asset" ? intent.asset : `${intent.asset}:${intent.payee}`;
}

function floorFixed(value: bigint): bigint {
  return value / FIXED_SCALE;
}

type AdaptiveConfig = NonNullable<NonNullable<Policy["anomaly"]>["adaptive"]>;

/**
 * The policy's adaptive anomaly section after its shape checks, or undefined
 * when the policy has none. Every reader goes through here, so the checks
 * live in one place.
 */
function adaptiveConfig(policy: Policy): AdaptiveConfig | undefined {
  const config = policy.anomaly?.adaptive;
  if (config === undefined) return undefined;
  if (config.kind !== "ewma") {
    throw new TollwayError("invalid-policy", `unknown adaptive anomaly detector: ${config.kind}`);
  }
  if (!Number.isSafeInteger(config.warmupPeriods) || config.warmupPeriods < 1) {
    throw new TollwayError(
      "invalid-policy",
      "anomaly.adaptive.warmupPeriods must be a positive integer",
    );
  }
  return config;
}

function updateAdaptive(state: AdaptiveState, sample: bigint, config: AdaptiveConfig): void {
  const [alphaNumerator, alphaDenominator] = parseRational(
    config.smoothing,
    "anomaly.adaptive.smoothing",
  );
  if (alphaNumerator > alphaDenominator) {
    throw new TollwayError(
      "invalid-policy",
      "anomaly.adaptive.smoothing must be no greater than one",
    );
  }
  const growth =
    config.maxBaselineGrowthPerMinute == null
      ? undefined
      : parseAmount(config.maxBaselineGrowthPerMinute);
  const sampleFixed = sample * FIXED_SCALE;
  if (state.baseline === undefined) {
    state.baseline = sampleFixed;
    state.deviation = 0n;
    state.samples = 1;
    return;
  }
  const baseline = state.baseline;
  const delta = sampleFixed - baseline;
  let change = (delta * alphaNumerator) / alphaDenominator;
  if (growth !== undefined && change > growth * FIXED_SCALE) change = growth * FIXED_SCALE;
  state.baseline = baseline + change;
  const deviationDelta = (delta < 0n ? -delta : delta) - state.deviation;
  state.deviation += (deviationDelta * alphaNumerator) / alphaDenominator;
  state.samples += 1;
}

const perModelDisabled: RuleEvaluator = ({ policy, intent }) => {
  const base = { id: "per-model-disabled", rule: "per-model-disabled" } as const;
  const configured = Object.values(policy.perModel ?? {}).some((cfg) => cfg?.enabled != null);
  const enabled = policy.perModel?.[intent.model]?.enabled;
  const empty = { limit: null, current: null, projected: null, window: null };
  if (enabled == null) {
    return {
      ...base,
      ...empty,
      configured,
      outcome: "not-applicable",
      detail: `policy does not enable or disable settlement model ${intent.model}`,
    };
  }
  return {
    ...base,
    ...empty,
    configured,
    outcome: enabled ? "pass" : "fail",
    detail: enabled
      ? `settlement model ${intent.model} is enabled by policy`
      : `settlement model ${intent.model} is disabled by policy`,
  };
};

/**
 * The minimum channel deposit guards opening a channel, not each payment on
 * one (#181). Comparing every per-request price with it blocked each channel
 * payment priced below the minimum, and no deposit was ever checked.
 * `evaluateChannelOpen` checks the deposit, so this rule never applies to a
 * payment. It stays in the trace so the reason is visible.
 */
const minChannelDeposit: RuleEvaluator = ({ policy, intent }) => {
  const base = { id: "min-channel-deposit", rule: "min-channel-deposit", window: null } as const;
  const configured = Object.values(policy.perModel ?? {}).some(
    (cfg) => cfg?.minChannelDeposit != null,
  );
  return {
    ...base,
    configured,
    outcome: "not-applicable",
    limit: null,
    current: null,
    projected: null,
    detail:
      intent.model === "mpp-channel"
        ? "minimum channel deposit is checked when a channel opens, not per payment"
        : `minimum channel deposit does not apply to ${intent.model}`,
  };
};

type SpendCeilingId =
  | "budget-daily"
  | "budget-total"
  | "per-service"
  | "per-service-daily"
  | "per-service-window"
  | "per-resource"
  | "per-resource-daily"
  | "per-resource-window";

type SpendCeilingRule =
  | "budget"
  | "per-service"
  | "per-service-daily"
  | "per-service-window"
  | "per-resource"
  | "per-resource-daily"
  | "per-resource-window";

function ruleOf(id: SpendCeilingId): SpendCeilingRule {
  switch (id) {
    case "budget-daily":
    case "budget-total":
      return "budget";
    case "per-service":
      return "per-service";
    case "per-service-daily":
      return "per-service-daily";
    case "per-service-window":
      return "per-service-window";
    case "per-resource":
      return "per-resource";
    case "per-resource-daily":
      return "per-resource-daily";
    case "per-resource-window":
      return "per-resource-window";
  }
}

/** Shared shape of every spend ceiling rule. */
function spendCeiling(
  id: SpendCeilingId,
  name: string,
  subject: string,
  limitValue: string | undefined,
  configured: boolean,
  current: bigint,
  amount: bigint,
  window: PolicyWindow,
): PolicyTraceEntry {
  const rule = ruleOf(id);
  if (limitValue == null) {
    return {
      id,
      rule,
      configured,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: `policy sets no ${name} ${subject}`,
    };
  }
  const limit = parseAmount(limitValue);
  const projected = current + amount;
  const fails = projected > limit;
  return {
    id,
    rule,
    configured,
    outcome: fails ? "fail" : "pass",
    limit: limit.toString(),
    current: current.toString(),
    projected: projected.toString(),
    window,
    // The failure wording predates the trace and callers may match on it.
    detail: fails
      ? `${name} exceeded ${subject}: ${projected} > ${limit}`
      : `${name} ${subject}: ${projected} <= ${limit}`,
  };
}

const budgetDaily: RuleEvaluator = ({ policy, intent, amount, state }) =>
  spendCeiling(
    "budget-daily",
    "daily budget",
    `for ${intent.asset}`,
    policy.budgets?.daily,
    policy.budgets?.daily != null,
    state.dailySpend.get(intent.asset) ?? 0n,
    amount,
    { kind: "utc-day", day: state.day },
  );

const budgetTotal: RuleEvaluator = ({ policy, intent, amount, state }) =>
  spendCeiling(
    "budget-total",
    "total budget",
    `for ${intent.asset}`,
    policy.budgets?.total,
    policy.budgets?.total != null,
    state.totalSpend.get(intent.asset) ?? 0n,
    amount,
    LIFETIME,
  );

const perService: RuleEvaluator = ({ policy, intent, amount, state }) =>
  spendCeiling(
    "per-service",
    "per-service cap",
    `for ${intent.payee}`,
    policy.perService?.[intent.payee]?.cap,
    Object.values(policy.perService ?? {}).some((cfg) => cfg?.cap != null),
    state.serviceSpend.get(serviceKey(intent.payee, intent.asset)) ?? 0n,
    amount,
    LIFETIME,
  );

// Issue #192 rule evaluators.

const perServiceDaily: RuleEvaluator = ({ policy, intent, amount, state }) =>
  spendCeiling(
    "per-service-daily",
    "per-service daily cap",
    `for ${intent.payee}`,
    policy.perService?.[intent.payee]?.dailyCap,
    Object.values(policy.perService ?? {}).some((cfg) => cfg?.dailyCap != null),
    state.serviceDailySpend.get(serviceKey(intent.payee, intent.asset)) ?? 0n,
    amount,
    { kind: "utc-day", day: state.day },
  );

const perServiceWindow: RuleEvaluator = ({ policy, intent, amount, now, state }) => {
  const config = policy.perService?.[intent.payee]?.window;
  const configured = Object.values(policy.perService ?? {}).some((cfg) => cfg?.window != null);
  if (config == null) {
    return {
      id: "per-service-window",
      rule: "per-service-window",
      configured,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: "policy sets no per-service rolling window cap",
    };
  }
  const windowSeconds = config.windowSeconds;
  const key = serviceKey(intent.payee, intent.asset);
  const accumulator = state.serviceWindowSpend.get(key);
  const current = accumulator ? accumulator.sum(now) : 0n;
  return spendCeiling(
    "per-service-window",
    `per-service ${windowSeconds}s rolling cap`,
    `for ${intent.payee}`,
    config.cap,
    true,
    current,
    amount,
    { kind: "sliding", seconds: windowSeconds },
  );
};

/** One `perResource` rule evaluated against one matching entry. */
function perResourceEntryCeiling(
  id: "per-resource" | "per-resource-daily" | "per-resource-window",
  { key, entry }: ResourceMatch,
  { intent, amount, now, state }: RuleInput,
): PolicyTraceEntry {
  const rKey = resourceKey(key, intent.asset);
  switch (id) {
    case "per-resource":
      return spendCeiling(
        "per-resource",
        "per-resource cap",
        `for ${key}`,
        entry.cap,
        true,
        state.resourceSpend.get(rKey) ?? 0n,
        amount,
        LIFETIME,
      );
    case "per-resource-daily":
      return spendCeiling(
        "per-resource-daily",
        "per-resource daily cap",
        `for ${key}`,
        entry.dailyCap,
        true,
        state.resourceDailySpend.get(rKey) ?? 0n,
        amount,
        { kind: "utc-day", day: state.day },
      );
    case "per-resource-window": {
      const windowConfig = entry.window;
      if (windowConfig == null) {
        return {
          id,
          rule: "per-resource-window",
          configured: true,
          outcome: "not-applicable",
          limit: null,
          current: null,
          projected: null,
          window: null,
          detail: `perResource entry for ${key} sets no rolling window`,
        };
      }
      const accumulator = state.resourceWindowSpend.get(rKey);
      return spendCeiling(
        "per-resource-window",
        `per-resource ${windowConfig.windowSeconds}s rolling cap`,
        `for ${key}`,
        windowConfig.cap,
        true,
        accumulator ? accumulator.sum(now) : 0n,
        amount,
        { kind: "sliding", seconds: windowConfig.windowSeconds },
      );
    }
  }
}

/** How far a passing entry's projected spend sits below its limit. */
function headroom(entry: PolicyTraceEntry): bigint {
  return BigInt(entry.limit ?? "0") - BigInt(entry.projected ?? "0");
}

/**
 * Evaluates one `perResource` rule against every entry that matches the
 * resource. The trace holds one entry per rule, so it reports the first
 * entry that fails, otherwise the passing entry with the least headroom,
 * which is the one that will refuse first.
 */
function perResourceCeiling(
  id: "per-resource" | "per-resource-daily" | "per-resource-window",
  name: string,
  input: RuleInput,
): PolicyTraceEntry {
  const perResource = input.policy.perResource;
  const configured = perResource !== undefined && Object.keys(perResource).length > 0;
  if (!configured) {
    return {
      id,
      rule: ruleOf(id),
      configured: false,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: `policy sets no ${name}`,
    };
  }
  const evaluated = matchResourceEntries(perResource, input.intent.resource).map((match) =>
    perResourceEntryCeiling(id, match, input),
  );
  const failing = evaluated.find((entry) => entry.outcome === "fail");
  if (failing) return failing;
  const passing = evaluated.filter((entry) => entry.outcome === "pass");
  const tightest = passing.reduce<PolicyTraceEntry | undefined>(
    (best, entry) => (best === undefined || headroom(entry) < headroom(best) ? entry : best),
    undefined,
  );
  if (tightest) return tightest;
  const [first] = evaluated;
  if (first) return first;
  return {
    id,
    rule: ruleOf(id),
    configured: true,
    outcome: "not-applicable",
    limit: null,
    current: null,
    projected: null,
    window: null,
    detail: `no perResource entry matches resource ${input.intent.resource}`,
  };
}

const perResource: RuleEvaluator = (input) =>
  perResourceCeiling("per-resource", "per-resource cap", input);
const perResourceDaily: RuleEvaluator = (input) =>
  perResourceCeiling("per-resource-daily", "per-resource daily cap", input);
const perResourceWindow: RuleEvaluator = (input) =>
  perResourceCeiling("per-resource-window", "per-resource rolling cap", input);

const rateLimit: RuleEvaluator = ({ intent, now, state }) => {
  if (state.rateLimiter === undefined) {
    return {
      id: "rate-limit",
      rule: "rate-limit",
      configured: false,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: "policy sets no rate limit",
    };
  }
  return state.rateLimiter.evaluate(intent.payee, now);
};

const anomaly: RuleEvaluator = ({ policy, intent, amount, now, state }) => {
  const base = { id: "anomaly", rule: "anomaly" } as const;
  const max = policy.anomaly?.maxSpendPerMinute;
  if (max == null) {
    return {
      ...base,
      configured: false,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: "policy sets no anomaly stop",
    };
  }
  const limit = parseAmount(max);
  let current = 0n;
  for (const sample of state.anomalySamples) {
    if (sample.ts >= now - WINDOW_MS && sample.asset === intent.asset) current += sample.amount;
  }
  const projected = current + amount;
  const fails = projected > limit;
  return {
    ...base,
    configured: true,
    outcome: fails ? "fail" : "pass",
    limit: limit.toString(),
    current: current.toString(),
    projected: projected.toString(),
    window: MINUTE_WINDOW,
    detail: fails
      ? `anomaly stop: projected minute spend ${projected} exceeds max ${limit}`
      : `anomaly stop: projected minute spend ${projected} within max ${limit}`,
  };
};

const adaptiveAnomaly: RuleEvaluator = ({ policy, intent, amount, state }) => {
  const base = { id: "anomaly-adaptive", rule: "anomaly-adaptive" } as const;
  const config = adaptiveConfig(policy);
  if (config === undefined) {
    return {
      ...base,
      configured: false,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: "policy sets no adaptive anomaly detector",
    };
  }
  const [sensitivityNumerator, sensitivityDenominator] = parseRational(
    config.sensitivity,
    "anomaly.adaptive.sensitivity",
  );
  const detector = state.adaptive.get(adaptiveKey(intent, config.scope ?? "asset"));
  const samples = detector?.samples ?? 0;
  const baseline = detector?.baseline ?? 0n;
  const deviation = detector?.deviation ?? 0n;
  const observed = (detector?.bucketSpend ?? 0n) + amount;
  const threshold = baseline + (deviation * sensitivityNumerator) / sensitivityDenominator;
  const fails = samples >= config.warmupPeriods && observed * FIXED_SCALE > threshold;
  return {
    ...base,
    configured: true,
    outcome: fails ? "fail" : "pass",
    limit: floorFixed(threshold).toString(),
    current: floorFixed(baseline).toString(),
    projected: observed.toString(),
    window: MINUTE_WINDOW,
    detail: fails
      ? `adaptive anomaly stop: observed rate ${observed} exceeds threshold ${floorFixed(threshold)} (baseline ${floorFixed(baseline)})`
      : samples < config.warmupPeriods
        ? `adaptive anomaly warm-up: ${samples} of ${config.warmupPeriods} completed periods`
        : `adaptive anomaly stop: observed rate ${observed} within threshold ${floorFixed(threshold)} (baseline ${floorFixed(baseline)})`,
  };
};

/**
 * Rebuilds an entry with its keys in the documented order. Stored traces are
 * read and diffed by people, and a stable key order keeps those diffs to the
 * values that changed.
 */
function inFieldOrder(entry: PolicyTraceEntry): PolicyTraceEntry {
  return {
    id: entry.id,
    rule: entry.rule,
    configured: entry.configured,
    outcome: entry.outcome,
    limit: entry.limit,
    current: entry.current,
    projected: entry.projected,
    window: entry.window,
    detail: entry.detail,
  };
}

/**
 * Evaluation order. Static checks on the intent run first, then the stateful
 * ceilings, the same order `check()` has always reported the first failure
 * in. Every rule runs even after one fails, so the trace is complete.
 */
const RULES: readonly RuleEvaluator[] = [
  perModelDisabled,
  minChannelDeposit,
  budgetDaily,
  budgetTotal,
  perService,
  perServiceDaily,
  perServiceWindow,
  perResource,
  perResourceDaily,
  perResourceWindow,
  rateLimit,
  anomaly,
  adaptiveAnomaly,
];

/**
 * Creates a policy engine that enforces budgets, per-service caps, per-model
 * constraints, rate limits, and anomaly stops. All state is held in memory;
 * see docs/design.md, "Policy and budgets".
 *
 * The policy is parsed with `policySchema` first, so a bad amount, a negative
 * rate, or an unknown key throws {@link PolicyValidationError} here, listing
 * every issue with its path, instead of failing on the first payment.
 * Unversioned policies from older releases are migrated to the current
 * version before validation.
 */
export function createPolicyEngine(
  input: PolicyInput,
  opts?: {
    clock?: () => number;
    onAnomalyDetected?: (event: AdaptiveAnomalyEvent) => void | Promise<void>;
  },
): PolicyEngine {
  const parsed = parsePolicy(input);
  if (!parsed.ok) throw new PolicyValidationError(parsed.issues);
  const policy = parsed.policy;
  const clock = opts?.clock ?? Date.now;
  const mode: PolicyMode = policy.mode ?? "enforce";
  const state: EngineState = {
    day: utcDate(clock),
    dailySpend: new Map(),
    totalSpend: new Map(),
    serviceSpend: new Map(),
    serviceDailySpend: new Map(),
    serviceWindowSpend: new Map(),
    resourceSpend: new Map(),
    resourceDailySpend: new Map(),
    resourceWindowSpend: new Map(),
    rateLimiter: createRateLimiter(policy.rateLimit),
    anomalySamples: [],
    adaptive: new Map(),
  };

  function resetDailyIfNeeded(): void {
    const today = utcDate(clock);
    if (today !== state.day) {
      state.dailySpend.clear();
      state.serviceDailySpend.clear();
      state.resourceDailySpend.clear();
      state.day = today;
    }
  }

  function pruneWindow(now: number): void {
    // Only the anomaly samples age out here. The rate limit keeps its own
    // log with its own windows (issue #197), so the two no longer share one.
    while (
      state.anomalySamples.length > 0 &&
      (state.anomalySamples[0]?.ts ?? Infinity) < now - WINDOW_MS
    ) {
      state.anomalySamples.shift();
    }
  }

  function rollAdaptive(now: number): void {
    const config = adaptiveConfig(policy);
    if (config === undefined) return;
    const bucketStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    for (const detector of state.adaptive.values()) {
      while (detector.bucketStart < bucketStart) {
        updateAdaptive(detector, detector.bucketSpend, config);
        detector.bucketStart += WINDOW_MS;
        detector.bucketSpend = 0n;
      }
    }
  }

  function applyRecord(intent: PaymentIntent): void {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);
    const { dailySpend, totalSpend, serviceSpend } = state;

    dailySpend.set(intent.asset, (dailySpend.get(intent.asset) ?? 0n) + amount);
    totalSpend.set(intent.asset, (totalSpend.get(intent.asset) ?? 0n) + amount);
    const svcKey = serviceKey(intent.payee, intent.asset);
    serviceSpend.set(svcKey, (serviceSpend.get(svcKey) ?? 0n) + amount);

    const now = clock();

    // Issue #192: record into the per-service daily and rolling-window
    // accumulators when the policy declares them. The rolling-window
    // RollingSum is created lazily (one per unique service+asset key)
    // and evicted below once its window drains.
    if (policy.perService?.[intent.payee]?.dailyCap != null) {
      state.serviceDailySpend.set(svcKey, (state.serviceDailySpend.get(svcKey) ?? 0n) + amount);
    }
    const serviceWindow = policy.perService?.[intent.payee]?.window;
    if (serviceWindow != null) {
      const windowSeconds = serviceWindow.windowSeconds;
      let accumulator = state.serviceWindowSpend.get(svcKey);
      if (!accumulator) {
        accumulator = new RollingSum({ windowMs: windowSeconds * 1_000 });
        state.serviceWindowSpend.set(svcKey, accumulator);
      }
      accumulator.add(now, amount);
    }

    // Issue #192: charge every perResource entry that matches, the same
    // set the evaluators check, so spend under a narrow prefix also counts
    // toward every broader entry above it.
    const resourceMatches = policy.perResource
      ? matchResourceEntries(policy.perResource, intent.resource)
      : [];
    for (const { key, entry } of resourceMatches) {
      const rKey = resourceKey(key, intent.asset);
      if (entry.cap != null) {
        state.resourceSpend.set(rKey, (state.resourceSpend.get(rKey) ?? 0n) + amount);
      }
      if (entry.dailyCap != null) {
        state.resourceDailySpend.set(rKey, (state.resourceDailySpend.get(rKey) ?? 0n) + amount);
      }
      if (entry.window != null) {
        let accumulator = state.resourceWindowSpend.get(rKey);
        if (!accumulator) {
          accumulator = new RollingSum({ windowMs: entry.window.windowSeconds * 1_000 });
          state.resourceWindowSpend.set(rKey, accumulator);
        }
        accumulator.add(now, amount);
      }
    }

    rollAdaptive(now);
    const config = adaptiveConfig(policy);
    if (config !== undefined) {
      const key = adaptiveKey(intent, config.scope ?? "asset");
      const bucketStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      const detector = state.adaptive.get(key) ?? {
        bucketStart,
        bucketSpend: 0n,
        baseline: undefined,
        deviation: 0n,
        samples: 0,
      };
      detector.bucketSpend += amount;
      state.adaptive.set(key, detector);
    }
    if (state.rateLimiter?.count === "settlements") state.rateLimiter.record(intent.payee, now);
    state.anomalySamples.push({ amount, asset: intent.asset, ts: now });
  }

  /**
   * Issue #192: drop RollingSum entries whose window has drained. This
   * is what keeps the per-service-window and per-resource-window maps
   * bounded under traffic that bursts and then stops.
   */
  function pruneRollingSums(now: number): void {
    for (const [key, accumulator] of state.serviceWindowSpend) {
      if (accumulator.prune(now)) {
        state.serviceWindowSpend.delete(key);
      }
    }
    for (const [key, accumulator] of state.resourceWindowSpend) {
      if (accumulator.prune(now)) {
        state.resourceWindowSpend.delete(key);
      }
    }
  }

  function evaluateNow(intent: PaymentIntent): PolicyTrace {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);
    const now = clock();
    pruneWindow(now);
    pruneRollingSums(now);
    rollAdaptive(now);

    const input: RuleInput = { policy, intent, amount, now, state };
    const entries = RULES.map((rule) => inFieldOrder(rule(input)));
    const firstFail = entries.find((entry) => entry.outcome === "fail");
    const wouldBlock = firstFail !== undefined;
    return {
      version: POLICY_TRACE_VERSION,
      mode,
      evaluatedAt: new Date(now).toISOString(),
      intent: {
        payee: intent.payee,
        resource: intent.resource,
        amount: intent.amount,
        asset: intent.asset,
        model: intent.model,
      },
      // Dry-run never blocks. The would-be block stays visible in wouldBlock,
      // blockedBy, and the failing entry.
      allowed: mode === "dry-run" || !wouldBlock,
      wouldBlock,
      blockedBy: firstFail?.id ?? null,
      entries,
    };
  }

  async function decide(trace: PolicyTrace, intent: PaymentIntent): Promise<PolicyDecision> {
    const decision = decisionFromTrace(trace);
    const adaptiveEntry = trace.entries.find((entry) => entry.id === "anomaly-adaptive");
    if (!decision.allowed && adaptiveEntry?.outcome === "fail") {
      await opts?.onAnomalyDetected?.({
        type: "anomaly.detected",
        intent,
        detail: adaptiveEntry.detail,
      });
    }
    return decision;
  }

  function countAttempt(intent: PaymentIntent): void {
    if (state.rateLimiter?.count === "attempts") state.rateLimiter.record(intent.payee, clock());
  }

  /**
   * The spend ceilings that apply to one asset and payee, each with its limit
   * and what has been spent under it. The daily ceiling is read after the
   * day rolls over, so yesterday's spend is not counted.
   */
  function spendCeilings(payee: string, asset: string): SpendCeilingLimit[] {
    resetDailyIfNeeded();
    const ceilings: SpendCeilingLimit[] = [];
    const daily = policy.budgets?.daily;
    if (daily != null) {
      ceilings.push({
        rule: "budget-daily",
        limit: parseAmount(daily),
        spent: state.dailySpend.get(asset) ?? 0n,
      });
    }
    const total = policy.budgets?.total;
    if (total != null) {
      ceilings.push({
        rule: "budget-total",
        limit: parseAmount(total),
        spent: state.totalSpend.get(asset) ?? 0n,
      });
    }
    const service = policy.perService?.[payee];
    const key = serviceKey(payee, asset);
    if (service?.cap != null) {
      ceilings.push({
        rule: "per-service",
        limit: parseAmount(service.cap),
        spent: state.serviceSpend.get(key) ?? 0n,
      });
    }
    // The #192 caps bound spend with this payee too, so a deposit sized past
    // them would lock funds the policy will not let the agent spend.
    if (service?.dailyCap != null) {
      ceilings.push({
        rule: "per-service-daily",
        limit: parseAmount(service.dailyCap),
        spent: state.serviceDailySpend.get(key) ?? 0n,
      });
    }
    if (service?.window != null) {
      ceilings.push({
        rule: "per-service-window",
        limit: parseAmount(service.window.cap),
        spent: state.serviceWindowSpend.get(key)?.sum(clock()) ?? 0n,
      });
    }
    return ceilings;
  }

  /** What is left under a ceiling. Never negative: an exhausted ceiling has none left. */
  function remaining(limit: bigint, spent: bigint): bigint {
    return limit > spent ? limit - spent : 0n;
  }

  function headroomOf(asset: string, payee: string): PolicyHeadroom {
    let tightest: { rule: SpendCeilingLimit["rule"]; left: bigint } | undefined;
    for (const ceiling of spendCeilings(payee, asset)) {
      const left = remaining(ceiling.limit, ceiling.spent);
      if (tightest === undefined || left < tightest.left) {
        tightest = { rule: ceiling.rule, left };
      }
    }
    return {
      asset,
      payee,
      headroom: tightest === undefined ? null : tightest.left.toString(),
      limitedBy: tightest?.rule ?? null,
    };
  }

  function evaluateChannelOpenNow(open: ChannelOpenIntent): ChannelOpenDecision {
    const deposit = parseAmount(open.deposit);
    const failures: Array<{ rule: ChannelOpenRule; detail: string }> = [];

    const min = policy.perModel?.["mpp-channel"]?.minChannelDeposit;
    if (min != null && deposit < parseAmount(min)) {
      failures.push({
        rule: "min-channel-deposit",
        detail: `deposit ${open.deposit} is below minimum channel deposit ${min}`,
      });
    }
    for (const ceiling of spendCeilings(open.payee, open.asset)) {
      const left = remaining(ceiling.limit, ceiling.spent);
      if (deposit > left) {
        failures.push({
          rule: ceiling.rule,
          detail: `deposit ${open.deposit} exceeds the ${ceiling.rule} headroom of ${left}`,
        });
      }
    }

    const blocker = failures[0];
    if (blocker === undefined) {
      return {
        allowed: true,
        wouldBlock: false,
        rule: null,
        detail: `deposit ${open.deposit} is within policy`,
      };
    }
    return {
      allowed: mode === "dry-run",
      wouldBlock: true,
      rule: blocker.rule,
      detail: blocker.detail,
    };
  }

  return {
    mode,

    async evaluate(intent: PaymentIntent): Promise<PolicyTrace> {
      return evaluateNow(intent);
    },

    async check(intent: PaymentIntent): Promise<PolicyDecision> {
      return decide(evaluateNow(intent), intent);
    },

    async admit(intent: PaymentIntent): Promise<PolicyTrace> {
      // Evaluating and counting happen in one synchronous step, with no
      // await between them, so two concurrent attempts cannot both see
      // the last free slot of an attempts-counted rate limit.
      const trace = evaluateNow(intent);
      if (trace.allowed) countAttempt(intent);
      return trace;
    },

    async recordAttempt(intent: PaymentIntent): Promise<void> {
      countAttempt(intent);
    },

    async record(intent: PaymentIntent): Promise<void> {
      applyRecord(intent);
      const now = clock();
      pruneWindow(now);
      pruneRollingSums(now);
    },

    async headroom(asset: string, payee: string): Promise<PolicyHeadroom> {
      return headroomOf(asset, payee);
    },

    async evaluateChannelOpen(open: ChannelOpenIntent): Promise<ChannelOpenDecision> {
      return evaluateChannelOpenNow(open);
    },
  };
}
