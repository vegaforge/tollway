/**
 * Request schemas and response shapes for the metrics API. Every payload that
 * crosses the boundary is parsed with zod before it touches a store, and the
 * schemas mirror the TypeScript types in
 * `@vegaforge/tollway-observability` field for field.
 */

import { settlementModels } from "@vegaforge/tollway-core";
import type {
  MetricsQuery,
  ModelAssetSpend,
  PayeeAssetSpend,
  PayerAssetSpend,
  SpendOutcomeCounts,
  SpendSummary,
  TimeseriesResult,
} from "@vegaforge/tollway-observability";
import { z } from "zod";

/** Most metrics one ingest request may carry. */
export const MAX_METRIC_BATCH = 1000;

export const paymentMetricSchema = z.strictObject({
  payer: z.string().min(1),
  payee: z.string().min(1),
  model: z.enum(settlementModels),
  // Integer string in the asset's smallest unit, the same rule receipts and
  // offers follow. A decimal point here would be summed as a wrong amount.
  amount: z.string().regex(/^[0-9]+$/, "amount must be an integer string"),
  asset: z.string().min(1),
  latencyMs: z.number().finite().nonnegative(),
  outcome: z.enum(["settled", "failed", "skipped"]),
  // ISO 8601 with a zone; a timestamp without one would mean different
  // instants depending on the process's time zone.
  at: z.iso.datetime(),
});

export const ingestBodySchema = z.strictObject({
  metrics: z.array(paymentMetricSchema).min(1).max(MAX_METRIC_BATCH),
});

const filterFields = {
  payer: z.string().min(1).optional(),
  payee: z.string().min(1).optional(),
  model: z.enum(settlementModels).optional(),
  asset: z.string().min(1).optional(),
  outcome: z.enum(["settled", "failed", "skipped"]).optional(),
};

export const summaryQuerySchema = z.strictObject({
  ...filterFields,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const seriesQuerySchema = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bucket: z.enum(["1m", "1h", "1d"]),
  groupBy: z.enum(["model", "payer", "payee"]).optional(),
  ...filterFields,
});

export const exportQuerySchema = z.strictObject({
  format: z.enum(["json", "csv"]),
  ...filterFields,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type SeriesQuery = z.infer<typeof seriesQuerySchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;

/** Turn the parsed query into the observability filter, dropping the rest. */
export function metricsQueryFrom(query: SummaryQuery | SeriesQuery | ExportQuery): MetricsQuery {
  const filters: MetricsQuery = {};
  if (query.payer !== undefined) filters.payer = query.payer;
  if (query.payee !== undefined) filters.payee = query.payee;
  if (query.model !== undefined) filters.model = query.model;
  if (query.asset !== undefined) filters.asset = query.asset;
  if (query.outcome !== undefined) filters.outcome = query.outcome;
  if (query.from !== undefined) filters.from = query.from;
  if (query.to !== undefined) filters.to = query.to;
  return filters;
}

/** One asset's settled total and the number of settled receipts behind it. */
export type AssetSummary = {
  asset: string;
  amount: string;
  count: number;
};

/**
 * The summary response. It deliberately has no cross-asset total: a USDC
 * amount and a native amount cannot be added, so the service never offers a
 * number that does. Counts are per outcome, and `count` is every matched
 * metric, so a dashboard can compute a failure rate.
 */
export type SummaryResponse = {
  count: number;
  byOutcome: SpendOutcomeCounts;
  byAsset: AssetSummary[];
  byModel: ModelAssetSpend[];
  byPayer: PayerAssetSpend[];
  byPayee: PayeeAssetSpend[];
};

/**
 * Project the hub's summary onto the API shape and add per-asset totals. The
 * per-asset sum is folded from the per-model rows with `bigint`, so it is the
 * same arithmetic and can never mix assets.
 */
export function toSummaryResponse(summary: SpendSummary): SummaryResponse {
  const byAsset = new Map<string, { amount: bigint; count: number }>();
  for (const total of summary.byModelAsset) {
    const current = byAsset.get(total.asset) ?? { amount: 0n, count: 0 };
    current.amount += BigInt(total.amount);
    current.count += total.count;
    byAsset.set(total.asset, current);
  }
  return {
    count: summary.count,
    byOutcome: summary.byOutcome,
    byAsset: [...byAsset.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([asset, total]) => ({
        asset,
        amount: total.amount.toString(),
        count: total.count,
      })),
    byModel: summary.byModelAsset,
    byPayer: summary.byPayerAsset,
    byPayee: summary.byPayeeAsset,
  };
}

/** The series response is the observability time series, unchanged. */
export type SeriesResponse = TimeseriesResult;

/** The body the ingest endpoint accepts. */
export type IngestBody = z.infer<typeof ingestBodySchema>;
