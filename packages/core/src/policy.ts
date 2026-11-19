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
  rateLimit?: {
    requestsPerMinute?: number;
  };
  anomaly?: {
    /** Trips the anomaly stop when spend in any minute exceeds this. */
    maxSpendPerMinute?: string;
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
  requestTimestamps: number[];
  anomalySamples: { amount: bigint; asset: string; ts: number }[];
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

const rateLimit: RuleEvaluator = ({ policy, state }) => {
  const base = { id: "rate-limit", rule: "rate-limit" } as const;
  const rpm = policy.rateLimit?.requestsPerMinute;
  if (rpm == null) {
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
  const limit = parseCount(rpm);
  const current = BigInt(state.requestTimestamps.length);
  const projected = current + 1n;
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
      ? `rate limit exceeded: ${current} requests in the last minute`
      : `rate limit: ${projected} of ${limit} requests in the last minute`,
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
];

/**
 * Creates a policy engine that enforces budgets, per-service caps, per-model
 * constraints, rate limits, and anomaly stops. All state is held in memory;
 * see docs/design.md, "Policy and budgets".
 *
 * Throws `invalid-policy` when `policy.mode` is not a known mode.
 */
export function createPolicyEngine(policy: Policy, opts?: { clock?: () => number }): PolicyEngine {
  const clock = opts?.clock ?? Date.now;
  const mode = resolveMode(policy);
  const state: EngineState = {
    day: utcDate(clock),
    dailySpend: new Map(),
    totalSpend: new Map(),
    serviceSpend: new Map(),
    requestTimestamps: [],
    anomalySamples: [],
  };

  function resetDailyIfNeeded(): void {
    const today = utcDate(clock);
    if (today !== state.day) {
      state.dailySpend.clear();
      state.day = today;
    }
  }

  function pruneWindow(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (
      state.requestTimestamps.length > 0 &&
      (state.requestTimestamps[0] ?? Infinity) < cutoff
    ) {
      state.requestTimestamps.shift();
    }
    while (state.anomalySamples.length > 0 && (state.anomalySamples[0]?.ts ?? Infinity) < cutoff) {
      state.anomalySamples.shift();
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
    state.requestTimestamps.push(now);
    state.anomalySamples.push({ amount, asset: intent.asset, ts: now });
  }

  async function evaluate(intent: PaymentIntent): Promise<PolicyTrace> {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);
    const now = clock();
    pruneWindow(now);

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

  return {
    mode,
    evaluate,

    async check(intent: PaymentIntent): Promise<PolicyDecision> {
      return decisionFromTrace(await evaluate(intent));
    },

    async record(intent: PaymentIntent): Promise<void> {
      applyRecord(intent);
      pruneWindow(clock());
    },
  };
}
