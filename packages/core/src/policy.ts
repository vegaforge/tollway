import { TollwayError } from "./errors.js";
import type { SettlementModel } from "./types.js";

/**
 * Policy is data, not code: a small declarative schema the engine enforces
 * across every settlement model. See docs/design.md, "Policy and budgets".
 *
 * All amounts are integer strings in the asset's smallest unit, same as
 * receipts.
 */
export type Policy = {
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

export type PolicyDecision = { allowed: true } | { allowed: false; rule: string; detail: string };

export interface PolicyEngine {
  check(intent: PaymentIntent): Promise<PolicyDecision>;
  /** Records a settled payment so budgets and anomaly windows advance. */
  record(intent: PaymentIntent): Promise<void>;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseAmount(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new TollwayError("invalid-receipt", `invalid amount: ${s}`);
  }
  return n;
}

/**
 * Creates a policy engine that enforces budgets, per-service caps, per-model
 * constraints, rate limits, and anomaly stops.  All state is held in memory;
 * see docs/design.md, "Policy and budgets".
 */
export function createPolicyEngine(policy: Policy): PolicyEngine {
  const dailySpend = new Map<string, number>();
  const totalSpend = new Map<string, number>();
  const serviceSpend = new Map<string, number>();
  const requestTimestamps: number[] = [];
  const anomalySamples: { amount: number; ts: number }[] = [];
  let lastResetDay = utcDate();

  function resetDailyIfNeeded(): void {
    const today = utcDate();
    if (today !== lastResetDay) {
      dailySpend.clear();
      lastResetDay = today;
    }
  }

  function applyRecord(intent: PaymentIntent): void {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);

    dailySpend.set(intent.asset, (dailySpend.get(intent.asset) ?? 0) + amount);
    totalSpend.set(intent.asset, (totalSpend.get(intent.asset) ?? 0) + amount);
    serviceSpend.set(intent.payee, (serviceSpend.get(intent.payee) ?? 0) + amount);

    const now = Date.now();
    requestTimestamps.push(now);
    anomalySamples.push({ amount, ts: now });
  }

  function pruneWindow(now: number): void {
    const cutoff = now - 60_000;
    while (requestTimestamps.length > 0 && (requestTimestamps[0] ?? Infinity) < cutoff) {
      requestTimestamps.shift();
    }
    while (anomalySamples.length > 0 && (anomalySamples[0]?.ts ?? Infinity) < cutoff) {
      anomalySamples.shift();
    }
  }

  return {
    async check(intent: PaymentIntent): Promise<PolicyDecision> {
      resetDailyIfNeeded();
      const amount = parseAmount(intent.amount);

      // 1. Daily budget
      if (policy.budgets?.daily != null) {
        const budget = parseAmount(policy.budgets.daily);
        const current = dailySpend.get(intent.asset) ?? 0;
        if (current + amount > budget) {
          throw new TollwayError(
            "budget-exceeded",
            `daily budget exceeded for ${intent.asset}: ${current + amount} > ${budget}`,
          );
        }
      }

      // 2. Total budget
      if (policy.budgets?.total != null) {
        const budget = parseAmount(policy.budgets.total);
        const current = totalSpend.get(intent.asset) ?? 0;
        if (current + amount > budget) {
          throw new TollwayError(
            "budget-exceeded",
            `total budget exceeded for ${intent.asset}: ${current + amount} > ${budget}`,
          );
        }
      }

      // 3. Per-service cap
      const svcCap = policy.perService?.[intent.payee]?.cap;
      if (svcCap != null) {
        const cap = parseAmount(svcCap);
        const current = serviceSpend.get(intent.payee) ?? 0;
        if (current + amount > cap) {
          return {
            allowed: false,
            rule: "per-service",
            detail: `per-service cap exceeded for ${intent.payee}: ${current + amount} > ${cap}`,
          };
        }
      }

      // 4. Per-model constraints
      const modelCfg = policy.perModel?.[intent.model];
      if (modelCfg) {
        if (modelCfg.enabled === false) {
          return {
            allowed: false,
            rule: "per-model-disabled",
            detail: `settlement model ${intent.model} is disabled by policy`,
          };
        }
        if (modelCfg.minChannelDeposit != null && intent.model === "mpp-channel") {
          const minDeposit = parseAmount(modelCfg.minChannelDeposit);
          if (amount < minDeposit) {
            return {
              allowed: false,
              rule: "min-channel-deposit",
              detail: `amount ${intent.amount} is below minimum channel deposit ${modelCfg.minChannelDeposit}`,
            };
          }
        }
      }

      // 5. Rate limit
      if (policy.rateLimit?.requestsPerMinute != null) {
        const now = Date.now();
        pruneWindow(now);
        if (requestTimestamps.length >= policy.rateLimit.requestsPerMinute) {
          return {
            allowed: false,
            rule: "rate-limit",
            detail: `rate limit exceeded: ${requestTimestamps.length} requests in the last minute`,
          };
        }
      }

      // 6. Anomaly stop
      if (policy.anomaly?.maxSpendPerMinute != null) {
        const maxSpend = parseAmount(policy.anomaly.maxSpendPerMinute);
        const now = Date.now();
        pruneWindow(now);
        const recentSpend = anomalySamples.reduce((sum, s) => sum + s.amount, 0);
        if (recentSpend + amount > maxSpend) {
          return {
            allowed: false,
            rule: "anomaly",
            detail: `anomaly stop: projected minute spend ${recentSpend + amount} exceeds max ${maxSpend}`,
          };
        }
      }

      return { allowed: true };
    },

    async record(intent: PaymentIntent): Promise<void> {
      applyRecord(intent);
      const now = Date.now();
      pruneWindow(now);
    },
  };
}
