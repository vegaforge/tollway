/**
 * The OpenAPI 3.1 document served at `/openapi.json`. It is written next to
 * the routes so a change to a route and a change to its description land in
 * one diff; the route tests check that every documented path is served.
 */

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", description: "Stable error code." },
        message: { type: "string" },
        details: { type: "array", items: { type: "string" } },
        limit: {
          type: "object",
          required: ["name", "value"],
          properties: { name: { type: "string" }, value: { type: "integer" } },
        },
      },
    },
  },
} as const;

const paymentMetricSchema = {
  type: "object",
  additionalProperties: false,
  required: ["payer", "payee", "model", "amount", "asset", "latencyMs", "outcome", "at"],
  properties: {
    payer: { type: "string", description: "Agent Stellar address." },
    payee: { type: "string", description: "Service Stellar address or identifier." },
    model: { type: "string", enum: ["x402", "mpp-charge", "mpp-channel"] },
    amount: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "Integer string in the asset's smallest unit.",
    },
    asset: { type: "string" },
    latencyMs: { type: "number", minimum: 0 },
    outcome: { type: "string", enum: ["settled", "failed", "skipped"] },
    at: { type: "string", format: "date-time", description: "ISO 8601 with a zone." },
  },
} as const;

const groupByValues = { type: "string", enum: ["model", "payer", "payee"] } as const;

function queryParam(
  name: string,
  schema: Record<string, unknown>,
  description?: string,
): Record<string, unknown> {
  return { name, in: "query", required: false, schema, ...(description ? { description } : {}) };
}

const filters = [
  queryParam("payer", { type: "string" }),
  queryParam("payee", { type: "string" }),
  queryParam("model", { type: "string", enum: ["x402", "mpp-charge", "mpp-channel"] }),
  queryParam("asset", { type: "string" }),
  queryParam("outcome", { type: "string", enum: ["settled", "failed", "skipped"] }),
  queryParam("from", { type: "string", format: "date-time" }, "Inclusive lower bound."),
  queryParam("to", { type: "string", format: "date-time" }, "Inclusive upper bound."),
];

const unauthorized = {
  description: "Missing or unknown API key.",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
} as const;

const forbidden = {
  description: "The key does not have the scope this route needs.",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
} as const;

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tollway service",
      version: "0.1.0",
      description:
        "Shared HTTP service for Tollway telemetry: ingest payment metrics and read spend summaries, time series and exports. Attribution: Tollway, Apache-2.0.",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A service API key. Send it as `Authorization: Bearer <key>`.",
        },
      },
      schemas: {
        Error: errorSchema,
        PaymentMetric: paymentMetricSchema,
        IngestBody: {
          type: "object",
          additionalProperties: false,
          required: ["metrics"],
          properties: {
            metrics: {
              type: "array",
              minItems: 1,
              maxItems: 1000,
              items: { $ref: "#/components/schemas/PaymentMetric" },
            },
          },
        },
        Summary: {
          type: "object",
          required: ["count", "byOutcome", "byAsset", "byModel", "byPayer", "byPayee"],
          properties: {
            count: { type: "integer", description: "Matched metrics of every outcome." },
            byOutcome: {
              type: "object",
              required: ["settled", "failed", "skipped"],
              properties: {
                settled: { type: "integer" },
                failed: { type: "integer" },
                skipped: { type: "integer" },
              },
            },
            byAsset: {
              type: "array",
              items: {
                type: "object",
                required: ["asset", "amount", "count"],
                properties: {
                  asset: { type: "string" },
                  amount: { type: "string" },
                  count: { type: "integer" },
                },
              },
            },
            byModel: { type: "array", items: { $ref: "#/components/schemas/GroupTotal" } },
            byPayer: { type: "array", items: { $ref: "#/components/schemas/GroupTotal" } },
            byPayee: { type: "array", items: { $ref: "#/components/schemas/GroupTotal" } },
          },
        },
        GroupTotal: {
          type: "object",
          required: ["asset", "amount", "count"],
          properties: {
            model: { type: "string", enum: ["x402", "mpp-charge", "mpp-channel"] },
            payer: { type: "string" },
            payee: { type: "string" },
            asset: { type: "string" },
            amount: { type: "string", description: "Settled amount in the asset's base units." },
            count: { type: "integer", description: "Settled receipts in the group." },
          },
        },
        TimeseriesRow: {
          type: "object",
          required: ["model", "asset", "amount", "settled", "failed", "skipped", "latencyMs"],
          properties: {
            model: { type: "string", enum: ["x402", "mpp-charge", "mpp-channel"] },
            asset: { type: "string" },
            payee: { type: "string" },
            payer: { type: "string" },
            amount: { type: "string" },
            settled: { type: "integer" },
            failed: { type: "integer" },
            skipped: { type: "integer" },
            latencyMs: {
              type: ["object", "null"],
              required: ["p50", "p95", "p99"],
              properties: {
                p50: { type: "number" },
                p95: { type: "number" },
                p99: { type: "number" },
              },
            },
          },
        },
        Series: {
          type: "object",
          required: ["bucket", "groupBy", "from", "to", "buckets"],
          properties: {
            bucket: { type: "string", enum: ["1m", "1h", "1d"] },
            groupBy: { type: "string", enum: ["model", "payer", "payee"] },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            buckets: {
              type: "array",
              items: {
                type: "object",
                required: ["start", "end", "rows"],
                properties: {
                  start: { type: "string", format: "date-time" },
                  end: { type: "string", format: "date-time" },
                  rows: { type: "array", items: { $ref: "#/components/schemas/TimeseriesRow" } },
                },
              },
            },
          },
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          operationId: "health",
          summary: "Liveness probe.",
          responses: { "200": { description: "The process is up." } },
        },
      },
      "/readyz": {
        get: {
          operationId: "ready",
          summary: "Readiness probe.",
          responses: { "200": { description: "The service can answer requests." } },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "openapi",
          summary: "This document.",
          responses: { "200": { description: "The OpenAPI 3.1 document." } },
        },
      },
      "/v1/metrics": {
        post: {
          operationId: "ingestMetrics",
          summary: "Ingest a batch of payment metrics.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/IngestBody" } },
            },
          },
          responses: {
            "202": {
              description: "Every metric in the batch was accepted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["accepted"],
                    properties: { accepted: { type: "integer" } },
                  },
                },
              },
            },
            "400": {
              description: "The body is not a valid metrics batch.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "401": unauthorized,
            "403": forbidden,
          },
        },
      },
      "/v1/metrics/summary": {
        get: {
          operationId: "summarizeMetrics",
          summary: "Spend totals and outcome counts, per asset.",
          description:
            "Only settled metrics add to an amount. Amounts in different assets are never added together, so there is no cross-asset total.",
          security: [{ bearerAuth: [] }],
          parameters: filters,
          responses: {
            "200": {
              description: "The summary.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Summary" } },
              },
            },
            "400": {
              description: "Invalid query.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "401": unauthorized,
            "403": forbidden,
          },
        },
      },
      "/v1/metrics/series": {
        get: {
          operationId: "metricsSeries",
          summary: "Bucketed spend, counts and latency per asset.",
          description:
            "The range is [from, to), every bucket in it is returned, and the range and bucket count are bounded.",
          security: [{ bearerAuth: [] }],
          parameters: [
            queryParam("from", { type: "string", format: "date-time" }, "Required. Inclusive."),
            queryParam("to", { type: "string", format: "date-time" }, "Required. Exclusive."),
            queryParam("bucket", { type: "string", enum: ["1m", "1h", "1d"] }),
            queryParam("groupBy", groupByValues, "Defaults to model."),
            ...filters,
          ],
          responses: {
            "200": {
              description: "The time series.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Series" } },
              },
            },
            "400": {
              description: "Invalid query, or a range over the configured limit.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "401": unauthorized,
            "403": forbidden,
          },
        },
      },
      "/v1/metrics/export": {
        get: {
          operationId: "exportMetrics",
          summary: "Export matching metrics as JSON or CSV.",
          security: [{ bearerAuth: [] }],
          parameters: [queryParam("format", { type: "string", enum: ["json", "csv"] }), ...filters],
          responses: {
            "200": {
              description: "The export, as an attachment.",
              content: {
                "application/json": { schema: { type: "array", items: { type: "object" } } },
                "text/csv": { schema: { type: "string" } },
              },
            },
            "400": {
              description: "Invalid query, or more rows than the configured limit.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "401": unauthorized,
            "403": forbidden,
          },
        },
      },
    },
  };
}
