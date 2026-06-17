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
 * Creates a policy engine that enforces budgets, per-service caps, per-model
 * constraints, rate limits, and anomaly stops. All state is held in memory;
 * see docs/design.md, "Policy and budgets".
 */
export function createPolicyEngine(policy: Policy, opts?: { clock?: () => number }): PolicyEngine {
  const clock = opts?.clock ?? Date.now;
  const dailySpend = new Map<string, bigint>();
  const totalSpend = new Map<string, bigint>();
  const serviceSpend = new Map<string, bigint>();
  const requestTimestamps: number[] = [];
  const anomalySamples: { amount: bigint; ts: number }[] = [];
  let lastResetDay = utcDate(clock);

  function resetDailyIfNeeded(): void {
    const today = utcDate(clock);
    if (today !== lastResetDay) {
      dailySpend.clear();
      lastResetDay = today;
    }
  }

  function applyRecord(intent: PaymentIntent): void {
    resetDailyIfNeeded();
    const amount = parseAmount(intent.amount);

    dailySpend.set(intent.asset, (dailySpend.get(intent.asset) ?? 0n) + amount);
    totalSpend.set(intent.asset, (totalSpend.get(intent.asset) ?? 0n) + amount);
    const svcKey = `${intent.payee}:${intent.asset}`;
    serviceSpend.set(svcKey, (serviceSpend.get(svcKey) ?? 0n) + amount);

    const now = clock();
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

      // 1. Per-model constraints (static checks first)
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

      // 2. Daily budget
      if (policy.budgets?.daily != null) {
        const budget = parseAmount(policy.budgets.daily);
        const current = dailySpend.get(intent.asset) ?? 0n;
        if (current + amount > budget) {
          return {
            allowed: false,
            rule: "budget",
            detail: `daily budget exceeded for ${intent.asset}: ${current + amount} > ${budget}`,
          };
        }
      }

      // 3. Total budget
      if (policy.budgets?.total != null) {
        const budget = parseAmount(policy.budgets.total);
        const current = totalSpend.get(intent.asset) ?? 0n;
        if (current + amount > budget) {
          return {
            allowed: false,
            rule: "budget",
            detail: `total budget exceeded for ${intent.asset}: ${current + amount} > ${budget}`,
          };
        }
      }

      // 4. Per-service cap
      const svcCap = policy.perService?.[intent.payee]?.cap;
      if (svcCap != null) {
        const cap = parseAmount(svcCap);
        const key = `${intent.payee}:${intent.asset}`;
        const current = serviceSpend.get(key) ?? 0n;
        if (current + amount > cap) {
          return {
            allowed: false,
            rule: "per-service",
            detail: `per-service cap exceeded for ${intent.payee}: ${current + amount} > ${cap}`,
          };
        }
      }

      // 5. Rate limit
      if (policy.rateLimit?.requestsPerMinute != null) {
        const now = clock();
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
        const now = clock();
        pruneWindow(now);
        const recentSpend = anomalySamples
          .filter((s) => s.ts >= now - 60_000)
          .reduce((sum, s) => sum + s.amount, 0n);
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
      const now = clock();
      pruneWindow(now);
    },
  };
}
