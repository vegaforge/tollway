import { NotImplementedError } from "./errors.js";
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

/**
 * TODO(phase 3): enforce budgets, per-service caps, per-model constraints,
 * rate limits, and anomaly stops, and map what we can down to OpenZeppelin
 * smart-account policies. See docs/design.md, "Policy and budgets".
 */
export function createPolicyEngine(_policy: Policy): PolicyEngine {
  throw new NotImplementedError("the policy engine", 'docs/design.md, "Policy and budgets"');
}
