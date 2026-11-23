/**
 * The service app: a Hono application that ingests payment metrics and serves
 * spend summaries, time series and exports. Every route that touches metrics
 * needs an API key with the matching scope; the health and OpenAPI routes do
 * not.
 *
 * The service holds no receipt signing key and makes no outbound call, so it
 * cannot move a payment. It is an optional read and write surface over
 * telemetry, described in docs/design.md, "Architecture" (shared service).
 */

import { MetricsQueryTooLargeError, parseIsoTimestamp } from "@vegaforge/tollway-observability";
import { Hono } from "hono";
import { requireScope, type ServiceApiKey } from "./auth.js";
import { type ApiErrorBody, apiError } from "./http.js";
import {
  exportQuerySchema,
  ingestBodySchema,
  metricsQueryFrom,
  seriesQuerySchema,
  summaryQuerySchema,
  toSummaryResponse,
} from "./metrics.js";
import { openApiDocument } from "./openapi.js";
import { createInMemoryMetricsStore, type MetricsStore } from "./store.js";

/** Bounds that keep one dashboard query from exhausting the process. */
export type MetricsLimits = {
  /** Widest range a series or export query may cover, in milliseconds. */
  maxRangeMs: number;
  /** Most metrics one export may return. */
  maxExportRows: number;
};

/** Ninety days, or 10 000 rows: wide enough for a dashboard, bounded for the process. */
export const DEFAULT_METRICS_LIMITS: MetricsLimits = {
  maxRangeMs: 90 * 24 * 60 * 60 * 1000,
  maxExportRows: 10_000,
};

export type ServiceConfig = {
  /** Keys that may call the API. An empty list makes every metrics route 401. */
  apiKeys: readonly ServiceApiKey[];
  /** Defaults to the in-memory observability hub. */
  store?: MetricsStore;
  /** Overrides for the request limits; checked at construction. */
  limits?: Partial<MetricsLimits>;
  /** Where an unexpected error is reported. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
  /** Clock for export filenames; tests inject one. */
  now?: () => number;
};

function resolveLimits(overrides?: Partial<MetricsLimits>): MetricsLimits {
  const limits = { ...DEFAULT_METRICS_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`service limit ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  return limits;
}

function invalidBody(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): ApiErrorBody {
  return apiError("invalid-request", "the request did not match the schema", {
    details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
  });
}

function invalidJson(error: unknown): boolean {
  return error instanceof SyntaxError;
}

/** The range a series or export query covers, or the refusal to explain. */
function checkRange(
  from: string | undefined,
  to: string | undefined,
  limits: MetricsLimits,
): ApiErrorBody | null {
  const fromMs = from === undefined ? null : parseIsoTimestamp(from);
  const toMs = to === undefined ? null : parseIsoTimestamp(to);
  if (from !== undefined && fromMs === null) {
    return apiError("invalid-request", "from is not a valid ISO 8601 timestamp");
  }
  if (to !== undefined && toMs === null) {
    return apiError("invalid-request", "to is not a valid ISO 8601 timestamp");
  }
  if (fromMs !== null && toMs !== null) {
    if (fromMs >= toMs) {
      return apiError("invalid-request", "from must be earlier than to");
    }
    if (toMs - fromMs > limits.maxRangeMs) {
      return apiError(
        "range-too-large",
        `the range is wider than the limit of ${limits.maxRangeMs} ms`,
        {
          limit: { name: "maxRangeMs", value: limits.maxRangeMs },
        },
      );
    }
  }
  return null;
}

export function createService(config: ServiceConfig): Hono {
  const store = config.store ?? createInMemoryMetricsStore();
  const limits = resolveLimits(config.limits);
  const report = config.onError ?? ((error: unknown) => console.error("tollway-service:", error));
  const now = config.now ?? (() => Date.now());

  const app = new Hono();

  // An unexpected failure is logged through the hook and answered without the
  // internal message, so a stack trace or a store path never reaches a caller.
  app.onError((error, context) => {
    report(error);
    return context.json(
      apiError("internal-error", "the service could not complete the request"),
      500,
    );
  });

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ready" }));
  app.get("/openapi.json", (context) => context.json(openApiDocument()));

  const ingest = requireScope(config.apiKeys, "ingest");
  const read = requireScope(config.apiKeys, "read");

  app.post("/v1/metrics", ingest, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch (error) {
      if (invalidJson(error)) {
        return context.json(apiError("invalid-request", "the request body is not JSON"), 400);
      }
      throw error;
    }
    const parsed = ingestBodySchema.safeParse(body);
    if (!parsed.success) {
      return context.json(invalidBody(parsed.error), 400);
    }
    await store.record(parsed.data.metrics);
    return context.json({ accepted: parsed.data.metrics.length }, 202);
  });

  app.get("/v1/metrics/summary", read, async (context) => {
    const parsed = summaryQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(invalidBody(parsed.error), 400);
    }
    const rangeError = checkRange(parsed.data.from, parsed.data.to, limits);
    if (rangeError) return context.json(rangeError, 400);

    const summary = await store.summarize(metricsQueryFrom(parsed.data));
    return context.json(toSummaryResponse(summary));
  });

  app.get("/v1/metrics/series", read, async (context) => {
    const parsed = seriesQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(invalidBody(parsed.error), 400);
    }
    const query = parsed.data;
    const rangeError = checkRange(query.from, query.to, limits);
    if (rangeError) return context.json(rangeError, 400);

    try {
      const series = await store.timeseries({
        ...metricsQueryFrom(query),
        from: query.from,
        to: query.to,
        bucket: query.bucket,
        ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy }),
      });
      return context.json(series);
    } catch (error) {
      if (error instanceof MetricsQueryTooLargeError) {
        return context.json(
          apiError("series-too-large", error.message, {
            limit: { name: error.limit, value: error.maximum },
          }),
          400,
        );
      }
      throw error;
    }
  });

  app.get("/v1/metrics/export", read, async (context) => {
    const parsed = exportQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(invalidBody(parsed.error), 400);
    }
    const query = parsed.data;
    const rangeError = checkRange(query.from, query.to, limits);
    if (rangeError) return context.json(rangeError, 400);

    const filter = metricsQueryFrom(query);
    const matched = await store.summarize(filter);
    if (matched.count > limits.maxExportRows) {
      return context.json(
        apiError(
          "export-too-large",
          `the export would return ${matched.count} metrics, more than the limit of ${limits.maxExportRows}`,
          { limit: { name: "maxExportRows", value: limits.maxExportRows } },
        ),
        400,
      );
    }

    const body = await store.export(query.format, filter);
    const stamp = new Date(now()).toISOString().replaceAll(":", "-").replaceAll(".", "-");
    context.header(
      "Content-Disposition",
      `attachment; filename="tollway-metrics-${stamp}.${query.format}"`,
    );
    context.header(
      "Content-Type",
      query.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
    );
    return context.body(body);
  });

  return app;
}
