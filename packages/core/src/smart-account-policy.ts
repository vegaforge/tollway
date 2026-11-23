import { TollwayError } from "./errors.js";
import { type PolicyInput, PolicyValidationError, parsePolicy } from "./policy-schema.js";

/** A constraint the account owner can install through their wallet. */
export type SmartAccountConstraint = {
  asset: string;
  tokenContract: string;
  limit: string;
  periodLedgers: number;
  sourceRule: "budget-daily";
};

export type SmartAccountResidual = {
  rule: string;
  reason: string;
};

export type SmartAccountInvocation = {
  method: "install-spending-limit";
  tokenContract: string;
  limit: string;
  periodLedgers: number;
  /** Description only. The account owner supplies and signs the transaction. */
  unsigned: true;
};

export type SmartAccountPlan = {
  constraints: readonly SmartAccountConstraint[];
  residual: readonly SmartAccountResidual[];
  invocations: readonly SmartAccountInvocation[];
};

export type SmartAccountPlannerOptions = {
  tokenContracts: Readonly<Record<string, string>>;
  dailyPeriodLedgers: number;
};

function amount(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value))
    throw new TollwayError("invalid-amount", `${field} must be an integer string`);
  return BigInt(value);
}

/**
 * Maps only the constraint that the current OpenZeppelin spending-limit
 * policy can express without changing its meaning: a per-token rolling ledger
 * window. The returned invocations are descriptions, never signed transactions.
 */
export function planSmartAccountPolicy(
  input: PolicyInput,
  options: SmartAccountPlannerOptions,
): SmartAccountPlan {
  // Validate the same way createPolicyEngine does, so a plan is never built
  // from a policy the engine would refuse.
  const parsed = parsePolicy(input);
  if (!parsed.ok) throw new PolicyValidationError(parsed.issues);
  const policy = parsed.policy;
  if (!Number.isSafeInteger(options.dailyPeriodLedgers) || options.dailyPeriodLedgers <= 0) {
    throw new TollwayError("invalid-policy", "dailyPeriodLedgers must be a positive integer");
  }
  const constraints: SmartAccountConstraint[] = [];
  const invocations: SmartAccountInvocation[] = [];
  const residual: SmartAccountResidual[] = [];
  if (policy.budgets?.daily !== undefined) {
    const limit = amount(policy.budgets.daily, "budgets.daily").toString();
    for (const [asset, tokenContract] of Object.entries(options.tokenContracts)) {
      constraints.push({
        asset,
        tokenContract,
        limit,
        periodLedgers: options.dailyPeriodLedgers,
        sourceRule: "budget-daily",
      });
      invocations.push({
        method: "install-spending-limit",
        tokenContract,
        limit,
        periodLedgers: options.dailyPeriodLedgers,
        unsigned: true,
      });
    }
  }
  if (policy.budgets?.total !== undefined) {
    residual.push({
      rule: "budget-total",
      reason: "the spending-limit policy is a rolling period, not lifetime",
    });
  }
  if (
    policy.perService &&
    Object.values(policy.perService).some(
      (entry) =>
        entry?.cap !== undefined || entry?.dailyCap !== undefined || entry?.window !== undefined,
    )
  ) {
    residual.push({
      rule: "per-service",
      reason: "the account policy scopes token transfers, not payees",
    });
  }
  if (policy.perResource && Object.keys(policy.perResource).length > 0) {
    residual.push({
      rule: "per-resource",
      reason: "the account policy scopes token transfers, not the resource paid for",
    });
  }
  if (policy.rateLimit?.requestsPerMinute !== undefined) {
    residual.push({
      rule: "rate-limit",
      reason: "the account policy limits token amount, not request count",
    });
  }
  if (policy.anomaly?.maxSpendPerMinute !== undefined || policy.anomaly?.adaptive !== undefined) {
    residual.push({
      rule: "anomaly",
      reason: "adaptive and minute anomaly detection remain application-layer rules",
    });
  }
  if (policy.budgets?.daily !== undefined) {
    residual.push({
      rule: "budget-daily",
      reason: "UTC-day reset is not identical to a ledger rolling window",
    });
  }
  return { constraints, residual, invocations };
}

export type InstalledSpendingLimit = {
  asset: string;
  tokenContract: string;
  limit: string;
  periodLedgers: number;
};

export type SmartAccountPolicyReader = {
  /** Performs a read-only Soroban simulation. It must not submit a transaction. */
  readSpendingLimits(): Promise<readonly InstalledSpendingLimit[]>;
};

export type SmartAccountCheck = {
  asset: string;
  status: "weaker" | "equal" | "stronger" | "missing";
  detail: string;
};

export async function checkSmartAccountPolicy(
  plan: SmartAccountPlan,
  reader: SmartAccountPolicyReader,
): Promise<readonly SmartAccountCheck[]> {
  const installed = await reader.readSpendingLimits();
  return plan.constraints.map((expected) => {
    const actual = installed.find((entry) => entry.asset === expected.asset);
    if (!actual) {
      return {
        asset: expected.asset,
        status: "missing",
        detail: "no installed spending limit for this asset",
      };
    }
    const expectedLimit = BigInt(expected.limit);
    const actualLimit = BigInt(actual.limit);
    if (actual.periodLedgers > expected.periodLedgers || actualLimit > expectedLimit) {
      return {
        asset: expected.asset,
        status: "weaker",
        detail: "installed period or limit permits more spend",
      };
    }
    if (actualLimit < expectedLimit || actual.periodLedgers < expected.periodLedgers) {
      return {
        asset: expected.asset,
        status: "stronger",
        detail: "installed spending limit is stricter",
      };
    }
    return {
      asset: expected.asset,
      status: "equal",
      detail: "installed limit matches the planned constraint",
    };
  });
}
