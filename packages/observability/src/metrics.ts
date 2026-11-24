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
  /** Inclusive ISO 8601 bounds. */
  from?: string;
  to?: string;
};

/**
 * Aggregated spend over a query window. Amounts are integer strings in the
 * asset's smallest unit (same convention as `PaymentMetric.amount` and the
 * canonical receipt). Every amount field counts metrics of every outcome
 * (settled, failed and skipped); `count` is the number of matched metrics.
 * Keys for `byPayer` / `byPayee` are the payer / payee addresses exactly as
 * they appear on the recorded metrics. For settled-only amounts, an outcome
 * split and latency, use `ObservabilityHub.timeseries`.
 */
export type SpendSummary = {
  /**
   * @deprecated Adds amounts across assets, so it is only meaningful when the
   * window holds a single asset. Use `byAsset`.
   */
  totalAmount: string;
  count: number;
  /**
   * Amount per asset, keyed by `PaymentMetric.asset`. Amounts in different
   * assets are never added together.
   */
  byAsset: Record<string, string>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries`, whose rows are
   * keyed by model and asset.
   */
  byModel: Partial<Record<SettlementModel, string>>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries` with
   * `groupBy: "payer"`.
   */
  byPayer: Record<string, string>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries` with
   * `groupBy: "payee"`.
   */
  byPayee: Record<string, string>;
};
