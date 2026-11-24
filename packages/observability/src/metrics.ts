import type { SettlementModel } from "@vegaforge/tollway-core";

/** A single measured payment, the unit metrics roll up from. */
export type PaymentMetric = {
  payer: string;
  payee: string;
  model: SettlementModel;
  amount: string;
  asset: string;
  latencyMs: number;
  outcome: "settled" | "failed" | "skipped";
  at: string;
};

export type MetricsQuery = {
  payer?: string;
  payee?: string;
  model?: SettlementModel;
  /** Asset identifier exactly as the recorded metric carries it. */
  asset?: string;
  /** Only metrics with this outcome. */
  outcome?: PaymentMetric["outcome"];
  /** Inclusive ISO 8601 bounds. */
  from?: string;
  to?: string;
};

/** How many matched metrics ended in each outcome. */
export type SpendOutcomeCounts = {
  settled: number;
  failed: number;
  skipped: number;
};

/** Spend settled through one model in one asset. */
export type ModelAssetSpend = {
  model: SettlementModel;
  asset: string;
  amount: string;
  count: number;
};

/** Spend paid by one payer in one asset. */
export type PayerAssetSpend = {
  payer: string;
  asset: string;
  amount: string;
  count: number;
};

/** Spend paid to one payee in one asset. */
export type PayeeAssetSpend = {
  payee: string;
  asset: string;
  amount: string;
  count: number;
};

/**
 * Aggregated spend over a query window. Amounts are integer strings in the
 * asset's smallest unit (same convention as `PaymentMetric.amount` and the
 * canonical receipt), summed with `bigint`.
 *
 * Only metrics with outcome `"settled"` add to an amount: a failed or skipped
 * payment moves no money, so counting it as spend overstates what was paid.
 * `count` is the number of matched metrics whatever their outcome, so it is
 * the denominator for the failure rate `byOutcome` describes. A breakdown's
 * `count` is the number of settled receipts behind its amount. Amounts in
 * different assets are never added together; every breakdown that carries
 * money is keyed by asset.
 */
export type SpendSummary = {
  /**
   * @deprecated Adds settled amounts across assets, so it is only meaningful
   * when the window holds a single asset. Use `byAsset`.
   */
  totalAmount: string;
  count: number;
  /** Matched metrics by outcome, the denominator for a failure rate. */
  byOutcome: SpendOutcomeCounts;
  /**
   * Settled amount per asset, keyed by `PaymentMetric.asset`. Amounts in
   * different assets are never added together.
   */
  byAsset: Record<string, string>;
  /**
   * @deprecated Adds settled amounts across assets. Use `byModelAsset`.
   */
  byModel: Partial<Record<SettlementModel, string>>;
  /**
   * @deprecated Adds settled amounts across assets. Use `byPayerAsset`.
   */
  byPayer: Record<string, string>;
  /**
   * @deprecated Adds settled amounts across assets. Use `byPayeeAsset`.
   */
  byPayee: Record<string, string>;
  /** Settled amount and matched count per model and asset, in asset order. */
  byModelAsset: ModelAssetSpend[];
  /** Settled amount and matched count per payer and asset, in asset order. */
  byPayerAsset: PayerAssetSpend[];
  /** Settled amount and matched count per payee and asset, in asset order. */
  byPayeeAsset: PayeeAssetSpend[];
};
