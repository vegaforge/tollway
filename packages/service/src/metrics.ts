import { settlementModels, TollwayError } from "@vegaforge/tollway-core";
import {
  type MetricsQuery,
  MetricsQueryTooLargeError,
  parseIsoTimestamp,
  type SpendSummary,
  timeseriesBuckets,
} from "@vegaforge/tollway-observability";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { defineRoute } from "./routes.js";

/**
 * The metrics API (#226): ingest `PaymentMetric` batches from many gates and
 * clients, and read the observability rollups back as a summary, a bucketed
 * time series, or a JSON or CSV export. Every route goes through the
 * service's `MetricsStore`, so the counting rules stay the observability
 * hub's and a persistent store (#217) only changes where metrics live.
 *
 * Mount it with `createService({ config, modules: [metricsModule()] })`.
 */

/** Error codes the metrics routes add to the service's own. */
export const metricsErrorCodes = [
  /** The range is wider than `maxRangeMs`. */
  "range-too-large",
  /** The time series would need more buckets or rows than the store allows. */
  "series-too-large",
  /** The export would return more metrics than `maxExportRows`. */
  "export-too-large",
] as const;

/** Most metrics one ingest request may carry. */
export const MAX_METRIC_BATCH = 1000;

/** Bounds that keep one dashboard query from exhausting the process. */
export type MetricsLimits = {
  /** Widest range a summary, series or export query may cover, in milliseconds. */
  maxRangeMs: number;
  /** Most metrics one export may return. */
  maxExportRows: number;
};

/** Ninety days, or 10 000 rows: wide enough for a dashboard, bounded for the process. */
export const DEFAULT_METRICS_LIMITS: MetricsLimits = {
  maxRangeMs: 90 * 24 * 60 * 60 * 1000,
  maxExportRows: 10_000,
};

export type MetricsModuleOptions = {
  /** Overrides for the request limits. Each must be a positive integer. */
  limits?: Partial<MetricsLimits>;
  /** Clock for export file names. Tests inject one. */
  now?: () => number;
};

const outcomes = ["settled", "failed", "skipped"] as const;

export const paymentMetricSchema = z.strictObject({
  payer: z.string().min(1),
  payee: z.string().min(1),
  model: z.enum(settlementModels),
  // An integer string in the asset's smallest unit, the rule receipts and
  // offers follow. A decimal point here would be summed as a wrong amount.
  amount: z.string().regex(/^[0-9]+$/, "amount must be an integer string"),
  asset: z.string().min(1),
  latencyMs: z.number().finite().nonnegative(),
  outcome: z.enum(outcomes),
  // With a zone: a timestamp without one names a different instant
  // depending on the process's time zone.
  at: z.iso.datetime({ offset: true }),
});

export const ingestBodySchema = z.strictObject({
  metrics: z.array(paymentMetricSchema).min(1).max(MAX_METRIC_BATCH),
});

const filterFields = {
  payer: z.string().min(1).optional(),
  payee: z.string().min(1).optional(),
  model: z.enum(settlementModels).optional(),
  asset: z.string().min(1).optional(),
  outcome: z.enum(outcomes).optional(),
};

export const summaryQuerySchema = z.strictObject({
  ...filterFields,
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const seriesQuerySchema = z.strictObject({
  ...filterFields,
  // A series is always bounded: the range sets how many buckets it allocates.
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  bucket: z.enum(timeseriesBuckets),
  groupBy: z.enum(["model", "payer", "payee"]).optional(),
});

export const exportQuerySchema = z.strictObject({
  ...filterFields,
  format: z.enum(["json", "csv"]),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const amountSchema = z.string().regex(/^[0-9]+$/);

const assetTotalSchema = z.object({ asset: z.string(), amount: amountSchema, count: z.number() });

/**
 * The summary response. It deliberately has no cross-asset total: a USDC
 * amount and a native amount cannot be added, so the API never offers a
 * number that does. `count` is every matched metric and `byOutcome` splits
 * it, so a dashboard can compute a failure rate. Amounts count only settled
 * metrics.
 */
export const summaryResponseSchema = z.object({
  count: z.number(),
  byOutcome: z.object({ settled: z.number(), failed: z.number(), skipped: z.number() }),
  byAsset: z.array(assetTotalSchema),
  byModel: z.array(assetTotalSchema.extend({ model: z.enum(settlementModels) })),
  byPayer: z.array(assetTotalSchema.extend({ payer: z.string() })),
  byPayee: z.array(assetTotalSchema.extend({ payee: z.string() })),
});

export type SummaryResponse = z.infer<typeof summaryResponseSchema>;

const latencySchema = z.object({ p50: z.number(), p95: z.number(), p99: z.number() });

/** The observability time series, unchanged. */
export const seriesResponseSchema = z.object({
  bucket: z.enum(timeseriesBuckets),
  groupBy: z.enum(["model", "payer", "payee"]),
  from: z.string(),
  to: z.string(),
  buckets: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      rows: z.array(
        z.object({
          model: z.enum(settlementModels),
          asset: z.string(),
          payer: z.string().optional(),
          payee: z.string().optional(),
          amount: amountSchema,
          settled: z.number(),
          failed: z.number(),
          skipped: z.number(),
          latencyMs: latencySchema.nullable(),
        }),
      ),
    }),
  ),
});

/**
 * Projects the hub's summary onto the API shape. The per-asset totals come
 * straight from `byAsset`; their counts are folded from the per-model rows,
 * which partition the settled metrics, so they are exact.
 */
export function toSummaryResponse(summary: SpendSummary): SummaryResponse {
  const counts = new Map<string, number>();
  for (const row of summary.byModelAsset) {
    counts.set(row.asset, (counts.get(row.asset) ?? 0) + row.count);
  }
  return {
    count: summary.count,
    byOutcome: summary.byOutcome,
    byAsset: Object.keys(summary.byAsset)
      .sort()
      .map((asset) => ({
        asset,
        amount: summary.byAsset[asset] ?? "0",
        count: counts.get(asset) ?? 0,
      })),
    byModel: summary.byModelAsset,
    byPayer: summary.byPayerAsset,
    byPayee: summary.byPayeeAsset,
  };
}

function resolveLimits(overrides: Partial<MetricsLimits> | undefined): MetricsLimits {
  const limits = { ...DEFAULT_METRICS_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`metrics limit ${name} must be a positive integer, got ${value}`);
    }
  }
  return limits;
}

type Filters = {
  payer?: string | undefined;
  payee?: string | undefined;
  model?: MetricsQuery["model"] | undefined;
  asset?: string | undefined;
  outcome?: MetricsQuery["outcome"] | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

/** The parsed query as an observability filter, without undefined keys. */
function metricsQueryFrom(query: Filters): MetricsQuery {
  const filter: MetricsQuery = {};
  if (query.payer !== undefined) filter.payer = query.payer;
  if (query.payee !== undefined) filter.payee = query.payee;
  if (query.model !== undefined) filter.model = query.model;
  if (query.asset !== undefined) filter.asset = query.asset;
  if (query.outcome !== undefined) filter.outcome = query.outcome;
  if (query.from !== undefined) filter.from = query.from;
  if (query.to !== undefined) filter.to = query.to;
  return filter;
}

/**
 * Checks the range a query covers. Returns the error body to send, or null.
 * A one-sided or open range is allowed for a summary and an export, which
 * are bounded by what they return; a series is always bounded by its schema.
 */
function rangeProblem(query: Filters, limits: MetricsLimits) {
  if (query.from === undefined || query.to === undefined) return null;
  const fromMs = parseIsoTimestamp(query.from);
  const toMs = parseIsoTimestamp(query.to);
  if (fromMs === null || toMs === null) {
    return errorBody("invalid-request", "from and to must be ISO 8601 timestamps with a zone");
  }
  if (fromMs >= toMs) return errorBody("invalid-request", "from must be earlier than to");
  if (toMs - fromMs > limits.maxRangeMs) {
    return errorBody(
      "range-too-large",
      `the range is wider than the limit of ${limits.maxRangeMs} ms`,
      { limit: { name: "maxRangeMs", value: limits.maxRangeMs } },
    );
  }
  return null;
}

const rejected = { description: "The request was refused.", schema: errorBodySchema };

/** The metrics routes, as a module for `createService`. */
export function metricsModule(options: MetricsModuleOptions = {}): ServiceModule {
  // Checked when the module is created, so a bad limit fails at startup.
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;

  return ({ stores }) => [
    defineRoute({
      method: "post",
      path: "/v1/metrics",
      summary: "Ingest payment metrics",
      description: `Records a batch of up to ${MAX_METRIC_BATCH} PaymentMetric values.`,
      tags: ["metrics"],
      scope: "ingest",
      request: { body: ingestBodySchema },
      responses: {
        202: { description: "The batch was recorded.", schema: z.object({ accepted: z.number() }) },
        400: rejected,
      },
      handler: async (c, { body }) => {
        await stores.metrics.record(body.metrics);
        return c.json({ accepted: body.metrics.length }, 202);
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/metrics/summary",
      summary: "Spend summary",
      description:
        "Settled spend per asset, broken down by model, payer and payee, with counts per outcome. There is no cross-asset total.",
      tags: ["metrics"],
      scope: "read",
      request: { query: summaryQuerySchema },
      responses: {
        200: { description: "The summary.", schema: summaryResponseSchema },
        400: rejected,
      },
      handler: async (c, { query }) => {
        const problem = rangeProblem(query, limits);
        if (problem) return c.json(problem, 400);
        return c.json(toSummaryResponse(await stores.metrics.summarize(metricsQueryFrom(query))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/metrics/series",
      summary: "Bucketed spend and counts",
      description:
        "Settled spend, counts per outcome and latency percentiles per bucket, model and asset, optionally split by payer or payee. `to` is exclusive.",
      tags: ["metrics"],
      scope: "read",
      request: { query: seriesQuerySchema },
      responses: {
        200: { description: "The time series.", schema: seriesResponseSchema },
        400: rejected,
      },
      handler: async (c, { query }) => {
        const problem = rangeProblem(query, limits);
        if (problem) return c.json(problem, 400);
        try {
          const series = await stores.metrics.timeseries({
            ...metricsQueryFrom(query),
            from: query.from,
            to: query.to,
            bucket: query.bucket,
            ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy }),
          });
          return c.json(series);
        } catch (error) {
          if (error instanceof MetricsQueryTooLargeError) {
            return c.json(
              errorBody("series-too-large", error.message, {
                limit: { name: error.limit, value: error.maximum },
              }),
              400,
            );
          }
          if (error instanceof TollwayError && error.code === "invalid-metrics-query") {
            return c.json(errorBody("invalid-request", error.message), 400);
          }
          throw error;
        }
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/metrics/export",
      summary: "Export metrics",
      description:
        "The matched metrics as JSON or CSV, exactly as the observability hub exports them, as a file download.",
      tags: ["metrics"],
      scope: "read",
      request: { query: exportQuerySchema },
      responses: {
        200: { description: "The export, as application/json or text/csv." },
        400: rejected,
      },
      handler: async (c, { query }) => {
        const problem = rangeProblem(query, limits);
        if (problem) return c.json(problem, 400);
        const filter = metricsQueryFrom(query);
        const { count } = await stores.metrics.summarize(filter);
        if (count > limits.maxExportRows) {
          return c.json(
            errorBody(
              "export-too-large",
              `the export would return ${count} metrics, more than the limit of ${limits.maxExportRows}`,
              { limit: { name: "maxExportRows", value: limits.maxExportRows } },
            ),
            400,
          );
        }
        const body = await stores.metrics.export(query.format, filter);
        const stamp = new Date(now()).toISOString().replaceAll(":", "-").replaceAll(".", "-");
        c.header(
          "Content-Disposition",
          `attachment; filename="tollway-metrics-${stamp}.${query.format}"`,
        );
        c.header(
          "Content-Type",
          query.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        );
        return c.body(body);
      },
    }),
  ];
}
