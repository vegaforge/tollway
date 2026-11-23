import { TollwayError } from "./errors.js";
import {
  decisionFromTrace,
  POLICY_TRACE_VERSION,
  type PolicyDecision,
  type PolicyMode,
  type PolicyTrace,
  type PolicyTraceEntry,
  type PolicyWindow,
  policyModes,
} from "./policy-trace.js";
import type { SettlementModel } from "./types.js";

/**
 * Policy is data, not code: a small declarative schema the engine enforces
 * across every settlement model. See docs/design.md, "Policy and budgets".
 *
 * All amounts are integer strings in the asset's smallest unit, same as
 * receipts.
 */
export type Policy = {
  /**
   * `enforce` (the default) blocks a payment when a rule fails. `dry-run`
   * allows it and only marks the would-be block in the trace. Spend is
   * recorded the same way in both modes, so budgets stay real.
   */
  mode?: PolicyMode;
  budgets?: {
    /** Spend ceiling per UTC day. */
    daily?: string;
    /** Lifetime ceiling for this policy. */
    total?: string;
  };
  /** Caps per counterparty service, keyed by the payee address or service id. */
  perService?: Record<string, { cap?: string }>;
  perModel?: Partial<
    Record<
      SettlementModel,
      {
        enabled?: boolean;
        /** Channel mode only makes sense above a minimum deposit. */
        minChannelDeposit?: string;
      }
    >
  >;
  /**
   * Agent-side rate limit. Covered in docs/receipt-format and
   * apps/web/src/content/docs/policy.mdx ("Rate limit").
   *
   * Issue #197: `requestsPerMinute` is kept as a shorthand for
   * `windows: [{ windowSeconds: 60, limit }]` so policies written against
   * the pre-#197 schema still parse. New policies should use `windows`,
   * `scope`, and `count` explicitly.
   */
  rateLimit?: {
    /** Shorthand for a single 60s window. Mutually exclusive with `windows`. */
    requestsPerMinute?: number;
    /**
     * One or more sliding-window limits applied in parallel. A payment
     * fails rate-limit if any window is exceeded. Example: 60/min AND
     * 1000/hour: `windows: [{ windowSeconds: 60, limit: 60 }, { windowSeconds: 3600, limit: 1000 }]`.
     */
    windows?: ReadonlyArray<{
      /** Window length in seconds. Must be a positive integer. */
      windowSeconds: number;
      /** Maximum requests allowed in the window. Non-negative integer. */
      limit: number;
    }>;
    /**
     * `settlements` (the default) counts each call to `record(intent)`.
     * `attempts` counts each call to `evaluate(intent)` regardless of
     * outcome - noting that concurrent attempts can still slip the
     * last-slot race until the reserve-at-check-time work from #189
     * lands.
     */
    count?: "settlements" | "attempts";
    /**
     * `global` (the default) counts every payment against one window.
     * `per-counterparty` splits the window per payee so one noisy
     * counterparty does not consume another's quota. The counterparty
     * key is the payee address, matching `perService`.
     */
    scope?: "global" | "per-counterparty";
    /**
     * Cap on how many counterparty keys the engine will track at once
     * when `scope === "per-counterparty"`. Defaults to 1024. When the
     * cap is reached, the engine evicts the least-recently-used
     * counterparty and the rate-limit rule reports it in the trace
     * detail. Set to `0` to disable the cap (unbounded memory).
     */
    perCounterpartyKeyLimit?: number;
  };
  anomaly?: {
    /** Trips the anomaly stop when spend in any minute exceeds this. */
    maxSpendPerMinute?: string;
    /** An explainable EWMA detector over committed per-minute spend. */
    adaptive?: {
      kind: "ewma";
      smoothing: { numerator: string; denominator: string };
      sensitivity: { numerator: string; denominator: string };
      /** Number of completed minute buckets before this rule can block. */
      warmupPeriods: number;
      scope?: "asset" | "asset-payee";
      /** Maximum increase allowed when a completed bucket trains the baseline. */
      maxBaselineGrowthPerMinute?: string;
    };
  };
};

/** A payment the engine is asked to allow or block, before it happens. */
export type PaymentIntent = {
  payee: string;
  resource: string;
  amount: string;
  asset: string;
  model: SettlementModel;
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
  /** Records a settled payment so budgets and anomaly windows advance. */
  record(intent: PaymentIntent): Promise<void>;
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

/**
 * A request count from the policy. It is a count, not an amount, but the
 * trace carries it as an integer string like every other limit, so a value
 * that is not a whole non-negative number is refused rather than rounded.
 */
function parseCount(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TollwayError(
      "invalid-policy",
      `rateLimit.requestsPerMinute must be a non-negative integer, got ${value}`,
    );
  }
  return BigInt(value);
}

function resolveMode(policy: Policy): PolicyMode {
  const mode: unknown = policy.mode ?? "enforce";
  // Policy may come from JSON. An unknown mode is refused: guessing would
  // either enforce what the operator meant to watch, or the reverse.
  const known = policyModes.find((candidate) => candidate === mode);
  if (known === undefined) {
    throw new TollwayError("invalid-policy", `unknown policy mode: ${String(mode)}`);
  }
  return known;
}

/** Spend and request history the stateful rules read. */
type EngineState = {
  day: string;
  dailySpend: Map<string, bigint>;
  totalSpend: Map<string, bigint>;
  serviceSpend: Map<string, bigint>;
  /**
   * Issue #197: rate-limit history, bucketised per counterparty (or the
   * sentinel `__global__` under global scope). The map value is a
   * sliding log of timestamps the rate-limit rule ages out per its
   * configured windows. `touchedAt` orders eviction when
   * `perCounterpartyKeyLimit` is reached.
   */
  rateLimit: Map<string, { timestamps: number[]; touchedAt: number }>;
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

const FIXED_SCALE = 1_000_000n;

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

const minChannelDeposit: RuleEvaluator = ({ policy, intent, amount }) => {
  const base = { id: "min-channel-deposit", rule: "min-channel-deposit", window: null } as const;
  const configured = Object.values(policy.perModel ?? {}).some(
    (cfg) => cfg?.minChannelDeposit != null,
  );
  const min = policy.perModel?.["mpp-channel"]?.minChannelDeposit;
  // The minimum only guards channel opens; other models have no deposit.
  if (intent.model !== "mpp-channel" || min == null) {
    return {
      ...base,
      configured,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      detail:
        intent.model === "mpp-channel"
          ? "policy sets no minimum channel deposit for mpp-channel"
          : `minimum channel deposit does not apply to ${intent.model}`,
    };
  }
  const minDeposit = parseAmount(min);
  const fails = amount < minDeposit;
  return {
    ...base,
    configured,
    outcome: fails ? "fail" : "pass",
    limit: minDeposit.toString(),
    current: null,
    projected: amount.toString(),
    detail: fails
      ? `amount ${intent.amount} is below minimum channel deposit ${min}`
      : `amount ${intent.amount} meets minimum channel deposit ${min}`,
  };
};

/** Shared shape of the three spend ceilings: daily, total, and per-service. */
function spendCeiling(
  id: "budget-daily" | "budget-total" | "per-service",
  name: string,
  subject: string,
  limitValue: string | undefined,
  configured: boolean,
  current: bigint,
  amount: bigint,
  window: PolicyWindow,
): PolicyTraceEntry {
  const rule = id === "per-service" ? "per-service" : "budget";
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

const DEFAULT_PER_COUNTERPARTY_KEY_LIMIT = 1024;
const GLOBAL_RATE_LIMIT_KEY = "__global__";

type ResolvedRateLimit = {
  windows: ReadonlyArray<{ windowMs: number; limit: bigint; windowSeconds: number }>;
  count: "settlements" | "attempts";
  scope: "global" | "per-counterparty";
  perCounterpartyKeyLimit: number;
};

/**
 * Normalises the rate-limit config into the shape the evaluator and the
 * writer both use. Rejects an invalid shape with `invalid-policy` so
 * callers see one error class, not a Zod spit at the field.
 */
function resolveRateLimit(policy: Policy): ResolvedRateLimit | undefined {
  const config = policy.rateLimit;
  if (!config) return undefined;
  if (config.requestsPerMinute != null && config.windows && config.windows.length > 0) {
    throw new TollwayError(
      "invalid-policy",
      "rateLimit: set either requestsPerMinute or windows, not both",
    );
  }
  const windows: Array<{ windowMs: number; limit: bigint; windowSeconds: number }> = [];
  if (config.windows && config.windows.length > 0) {
    for (const entry of config.windows) {
      if (!Number.isSafeInteger(entry.windowSeconds) || entry.windowSeconds <= 0) {
        throw new TollwayError(
          "invalid-policy",
          `rateLimit.windows[].windowSeconds must be a positive integer, got ${entry.windowSeconds}`,
        );
      }
      windows.push({
        windowSeconds: entry.windowSeconds,
        windowMs: entry.windowSeconds * 1000,
        limit: parseCount(entry.limit),
      });
    }
  } else if (config.requestsPerMinute != null) {
    windows.push({
      windowSeconds: 60,
      windowMs: 60_000,
      limit: parseCount(config.requestsPerMinute),
    });
  } else {
    return undefined;
  }
  const count = config.count ?? "settlements";
  const scope = config.scope ?? "global";
  const perCounterpartyKeyLimit =
    config.perCounterpartyKeyLimit ?? DEFAULT_PER_COUNTERPARTY_KEY_LIMIT;
  if (!Number.isSafeInteger(perCounterpartyKeyLimit) || perCounterpartyKeyLimit < 0) {
    throw new TollwayError(
      "invalid-policy",
      `rateLimit.perCounterpartyKeyLimit must be a non-negative integer, got ${perCounterpartyKeyLimit}`,
    );
  }
  return { windows, count, scope, perCounterpartyKeyLimit };
}

/** The counterparty key the rate limit measures under; `__global__` under global scope. */
function rateLimitKey(intent: PaymentIntent, scope: "global" | "per-counterparty"): string {
  return scope === "global" ? GLOBAL_RATE_LIMIT_KEY : intent.payee;
}

/**
 * Ages out timestamps older than the longest configured window. Keeping
 * only what matters means every per-key array is bounded by the sum of
 * the per-second request rate and the longest window; in practice a
 * few hundred entries at most.
 */
function pruneRateLimitEntry(timestamps: number[], now: number, longestMs: number): void {
  const cutoff = now - longestMs;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) <= cutoff) {
    timestamps.shift();
  }
}

/**
 * Evicts the least-recently-touched key when the per-counterparty cap
 * is hit. Only applies when scope is `per-counterparty` and the cap is
 * positive (a cap of 0 disables eviction).
 */
function evictLruIfNeeded(state: EngineState, perCounterpartyKeyLimit: number): number | undefined {
  if (perCounterpartyKeyLimit === 0) return undefined;
  if (state.rateLimit.size < perCounterpartyKeyLimit) return undefined;
  let lruKey: string | undefined;
  let lruAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of state.rateLimit) {
    if (key === GLOBAL_RATE_LIMIT_KEY) continue;
    if (entry.touchedAt < lruAt) {
      lruAt = entry.touchedAt;
      lruKey = key;
    }
  }
  if (lruKey !== undefined) {
    state.rateLimit.delete(lruKey);
  }
  return lruKey === undefined ? undefined : lruAt;
}

const rateLimit: RuleEvaluator = ({ policy, intent, now, state }) => {
  const base = { id: "rate-limit", rule: "rate-limit" } as const;
  // resolveRateLimit throws `invalid-policy` on a bad shape; let it
  // propagate - evaluate() is already the path that refuses a bad policy.
  const resolved = resolveRateLimit(policy);
  if (!resolved) {
    return {
      ...base,
      configured: false,
      outcome: "not-applicable",
      limit: null,
      current: null,
      projected: null,
      window: null,
      detail: "policy sets no rate limit",
    };
  }
  const key = rateLimitKey(intent, resolved.scope);
  const entry = state.rateLimit.get(key);
  const timestamps = entry?.timestamps ?? [];
  const longestMs = Math.max(...resolved.windows.map((w) => w.windowMs));
  // Age-out before measuring so `current` names the live count.
  const measured = [...timestamps];
  pruneRateLimitEntry(measured, now, longestMs);
  // Find the tightest violation (first failing window), reporting the
  // numbers for the tightest window when nothing fails.
  let failingWindow: (typeof resolved.windows)[number] | undefined;
  let failingCurrent = 0n;
  let tightestWindow = resolved.windows[0] ?? {
    windowMs: 60_000,
    limit: 0n,
    windowSeconds: 60,
  };
  let tightestCurrent = 0n;
  for (const w of resolved.windows) {
    const windowCutoff = now - w.windowMs;
    let count = 0n;
    for (const ts of measured) {
      if (ts > windowCutoff) count += 1n;
    }
    if (count + 1n > w.limit) {
      if (!failingWindow || count > failingCurrent) {
        failingWindow = w;
        failingCurrent = count;
      }
    }
    // Pick the tightest for reporting.
    if (!tightestWindow || w.limit - count < tightestWindow.limit - tightestCurrent) {
      tightestWindow = w;
      tightestCurrent = count;
    }
  }
  const reported = failingWindow ?? tightestWindow;
  const reportedCurrent = failingWindow ? failingCurrent : tightestCurrent;
  const projected = reportedCurrent + 1n;
  const windowShape: PolicyWindow = {
    kind: "sliding",
    seconds: reported.windowSeconds,
  };
  const where = resolved.scope === "per-counterparty" ? ` for ${intent.payee}` : "";
  const detail = failingWindow
    ? `rate limit${where} exceeded: ${reportedCurrent} requests in the last ${reported.windowSeconds} seconds (limit ${reported.limit})`
    : `rate limit${where}: ${projected} of ${reported.limit} requests in the last ${reported.windowSeconds} seconds`;
  return {
    ...base,
    configured: true,
    outcome: failingWindow ? "fail" : "pass",
    limit: reported.limit.toString(),
    current: reportedCurrent.toString(),
    projected: projected.toString(),
    window: windowShape,
    detail,
  };
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
  rateLimit,
  anomaly,
  adaptiveAnomaly,
];

/**
 * Creates a policy engine that enforces budgets, per-service caps, per-model
 * constraints, rate limits, and anomaly stops. All state is held in memory;
 * see docs/design.md, "Policy and budgets".
 *
 * Throws `invalid-policy` when `policy.mode` is not a known mode.
 */
export function createPolicyEngine(
  policy: Policy,
  opts?: {
    clock?: () => number;
    onAnomalyDetected?: (event: AdaptiveAnomalyEvent) => void | Promise<void>;
  },
): PolicyEngine {
  const clock = opts?.clock ?? Date.now;
  const mode = resolveMode(policy);
  const state: EngineState = {
    day: utcDate(clock),
    dailySpend: new Map(),
    totalSpend: new Map(),
    serviceSpend: new Map(),
    rateLimit: new Map(),
    anomalySamples: [],
    adaptive: new Map(),
  };

  function resetDailyIfNeeded(): void {
    const today = utcDate(clock);
    if (today !== state.day) {
      state.dailySpend.clear();
      state.day = today;
    }
  }

  function pruneWindow(now: number): void {
    // Issue #197: the anomaly window and the rate-limit window are now
    // independent. The anomaly rule still uses the hard-coded one-minute
    // sample window; the rate-limit window is per-configured-entry and
    // ages out inside the evaluator.
    while (
      state.anomalySamples.length > 0 &&
      (state.anomalySamples[0]?.ts ?? Infinity) < now - WINDOW_MS
    ) {
      state.anomalySamples.shift();
    }
    // Prune rate-limit entries whose longest window has fully drained.
    const resolved = (() => {
      try {
        return resolveRateLimit(policy);
      } catch {
        // An invalid policy throws at evaluate() time; pruning tolerates it.
        return undefined;
      }
    })();
    if (resolved) {
      const longestMs = Math.max(...resolved.windows.map((w) => w.windowMs));
      for (const [key, entry] of state.rateLimit) {
        pruneRateLimitEntry(entry.timestamps, now, longestMs);
        if (entry.timestamps.length === 0) {
          state.rateLimit.delete(key);
        }
      }
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
    recordRateLimit(now, intent, "settlements");
    state.anomalySamples.push({ amount, asset: intent.asset, ts: now });
  }

  /**
   * Writes a timestamp into the rate-limit log when the configured
   * `count` mode matches the trigger. `attempts` writes on evaluate;
   * `settlements` writes on record. Handles LRU eviction when
   * `perCounterpartyKeyLimit` is reached.
   */
  function recordRateLimit(
    now: number,
    intent: PaymentIntent,
    trigger: "settlements" | "attempts",
  ): void {
    const resolved = (() => {
      try {
        return resolveRateLimit(policy);
      } catch {
        return undefined;
      }
    })();
    if (!resolved) return;
    if (resolved.count !== trigger) return;
    const key = rateLimitKey(intent, resolved.scope);
    const existing = state.rateLimit.get(key);
    if (!existing) {
      if (resolved.scope === "per-counterparty") {
        evictLruIfNeeded(state, resolved.perCounterpartyKeyLimit);
      }
      state.rateLimit.set(key, { timestamps: [now], touchedAt: now });
      return;
    }
    existing.timestamps.push(now);
    existing.touchedAt = now;
  }

  async function evaluate(intent: PaymentIntent): Promise<PolicyTrace> {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);
    const now = clock();
    pruneWindow(now);
    rollAdaptive(now);

    const input: RuleInput = { policy, intent, amount, now, state };
    const entries = RULES.map((rule) => inFieldOrder(rule(input)));
    const firstFail = entries.find((entry) => entry.outcome === "fail");
    const wouldBlock = firstFail !== undefined;
    // Issue #197: `count: attempts` writes on evaluate so the rule sees
    // every attempt, not only settled ones. Full concurrency safety
    // across in-flight attempts follows the reserve-at-check-time work
    // in #189; until then, two concurrent attempts can still race the
    // last slot - documented in apps/web/src/content/docs/policy.mdx.
    recordRateLimit(now, intent, "attempts");
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

  return {
    mode,
    evaluate,

    async check(intent: PaymentIntent): Promise<PolicyDecision> {
      const trace = await evaluate(intent);
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
    },

    async record(intent: PaymentIntent): Promise<void> {
      applyRecord(intent);
      pruneWindow(clock());
    },
  };
}
