import type { PaymentMetric } from "@vegaforge/tollway-observability";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createService, type MetricsLimits, type ServiceConfig } from "./app.js";
import { hashApiKey, type ServiceApiKey } from "./auth.js";
import type { MetricsStore } from "./store.js";

const INGEST_KEY = "ingest-secret";
const READ_KEY = "read-secret";

let cachedKeys: ServiceApiKey[] | undefined;

async function keys(): Promise<ServiceApiKey[]> {
  if (!cachedKeys) {
    cachedKeys = [
      { id: "ingest", keyHash: await hashApiKey(INGEST_KEY), scopes: ["ingest"] },
      { id: "read", keyHash: await hashApiKey(READ_KEY), scopes: ["read"] },
    ];
  }
  return cachedKeys;
}

async function makeApp(overrides: Partial<Omit<ServiceConfig, "apiKeys">> = {}): Promise<Hono> {
  return createService({ apiKeys: await keys(), ...overrides });
}

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: overrides.payer ?? "GAGENTAAA",
    payee: overrides.payee ?? "GSERVICEAAA",
    model: overrides.model ?? "x402",
    amount: overrides.amount ?? "1000",
    asset: overrides.asset ?? "USDC:GA5Z",
    latencyMs: overrides.latencyMs ?? 42,
    outcome: overrides.outcome ?? "settled",
    at: overrides.at ?? "2026-06-26T10:00:00.000Z",
  };
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, ...extra };
}

async function ingest(app: Hono, metrics: PaymentMetric[]): Promise<Response> {
  return app.request("/v1/metrics", {
    method: "POST",
    headers: headers(INGEST_KEY, { "Content-Type": "application/json" }),
    body: JSON.stringify({ metrics }),
  });
}

async function read(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: headers(READ_KEY) });
}

describe("service health and OpenAPI", () => {
  it("serves health and readiness without a key", async () => {
    const app = await makeApp();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
  });

  it("publishes every metrics route and schema in /openapi.json", async () => {
    const app = await makeApp();
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/v1/metrics",
        "/v1/metrics/summary",
        "/v1/metrics/series",
        "/v1/metrics/export",
        "/healthz",
        "/readyz",
      ]),
    );
    expect(document.components.schemas).toHaveProperty("PaymentMetric");
    expect(document.components.schemas).toHaveProperty("Summary");
    expect(document.components.schemas).toHaveProperty("Series");
    expect(document.components.securitySchemes).toHaveProperty("bearerAuth");
  });
});

describe("service API-key auth", () => {
  it("rejects a request with no key", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/metrics/summary");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects an unknown key", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/metrics/summary", { headers: headers("not-a-key") });
    expect(response.status).toBe(401);
  });

  it("rejects a read key on ingest and an ingest key on read", async () => {
    const app = await makeApp();

    const ingestWithReadKey = await app.request("/v1/metrics", {
      method: "POST",
      headers: headers(READ_KEY, { "Content-Type": "application/json" }),
      body: JSON.stringify({ metrics: [metric()] }),
    });
    expect(ingestWithReadKey.status).toBe(403);

    const summaryWithIngestKey = await app.request("/v1/metrics/summary", {
      headers: headers(INGEST_KEY),
    });
    expect(summaryWithIngestKey.status).toBe(403);
    await expect(summaryWithIngestKey.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });
  });

  it("accepts the key as a case-insensitive Bearer scheme", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/metrics/summary", {
      headers: { Authorization: `bearer ${READ_KEY}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("POST /v1/metrics", () => {
  it("accepts a batch and records every metric", async () => {
    const app = await makeApp();
    const response = await ingest(app, [metric(), metric({ outcome: "failed", amount: "500" })]);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 2 });

    const summary = (await (await read(app, "/v1/metrics/summary")).json()) as { count: number };
    expect(summary.count).toBe(2);
  });

  it("rejects a body that is not the ingest object", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/metrics", {
      method: "POST",
      headers: headers(INGEST_KEY, { "Content-Type": "application/json" }),
      body: JSON.stringify([metric()]),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid-request" } });
  });

  it("rejects malformed JSON", async () => {
    const app = await makeApp();
    const response = await app.request("/v1/metrics", {
      method: "POST",
      headers: headers(INGEST_KEY, { "Content-Type": "application/json" }),
      body: "{",
    });
    expect(response.status).toBe(400);
  });

  it("rejects an empty batch", async () => {
    const app = await makeApp();
    const response = await ingest(app, []);
    expect(response.status).toBe(400);
  });

  it("rejects a non-integer amount, a missing asset and a timestamp without a zone", async () => {
    const app = await makeApp();
    for (const bad of [
      { ...metric(), amount: "1.5" },
      { ...metric(), asset: "" },
      { ...metric(), at: "2026-06-26T10:00:00" },
      { ...metric(), latencyMs: -1 },
      { ...metric(), extra: "no" },
    ]) {
      const response = await app.request("/v1/metrics", {
        method: "POST",
        headers: headers(INGEST_KEY, { "Content-Type": "application/json" }),
        body: JSON.stringify({ metrics: [bad] }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { details?: string[] } };
      expect(body.error.details?.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /v1/metrics/summary", () => {
  async function seeded(): Promise<Hono> {
    const app = await makeApp();
    await ingest(app, [
      metric({ amount: "1000", asset: "USDC:GA5Z", outcome: "settled" }),
      metric({ amount: "250", asset: "USDC:GA5Z", outcome: "settled", model: "mpp-charge" }),
      metric({ amount: "500", asset: "USDC:GA5Z", outcome: "failed" }),
      metric({ amount: "7", asset: "native", outcome: "settled" }),
      metric({ amount: "3", asset: "native", outcome: "skipped" }),
    ]);
    return app;
  }

  it("returns settled totals per asset, outcome counts, and no cross-asset total", async () => {
    const app = await seeded();
    const response = await read(app, "/v1/metrics/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("totalAmount");
    expect(body).toMatchObject({
      count: 5,
      byOutcome: { settled: 3, failed: 1, skipped: 1 },
      byAsset: [
        { asset: "USDC:GA5Z", amount: "1250", count: 2 },
        { asset: "native", amount: "7", count: 1 },
      ],
    });
    expect(body.byModel).toEqual([
      { model: "mpp-charge", asset: "USDC:GA5Z", amount: "250", count: 1 },
      { model: "x402", asset: "USDC:GA5Z", amount: "1000", count: 1 },
      { model: "x402", asset: "native", amount: "7", count: 1 },
    ]);
  });

  it("filters by asset, outcome, model and time range", async () => {
    const app = await makeApp();
    await ingest(app, [
      metric({ amount: "1000", at: "2026-06-26T09:00:00.000Z" }),
      metric({ amount: "10", asset: "native", outcome: "settled" }),
      metric({ amount: "5", asset: "native", outcome: "failed" }),
    ]);

    const native = (await (await read(app, "/v1/metrics/summary?asset=native")).json()) as {
      count: number;
      byAsset: Array<{ asset: string; amount: string }>;
    };
    expect(native).toMatchObject({ count: 2, byAsset: [{ asset: "native", amount: "10" }] });

    const failed = (await (await read(app, "/v1/metrics/summary?outcome=failed")).json()) as {
      count: number;
      byAsset: unknown[];
      byOutcome: Record<string, number>;
    };
    expect(failed).toMatchObject({ count: 1, byAsset: [], byOutcome: { failed: 1 } });

    const ranged = (await (
      await read(
        app,
        "/v1/metrics/summary?from=2026-06-26T00:00:00.000Z&to=2026-06-26T10:00:00.000Z",
      )
    ).json()) as { count: number };
    expect(ranged.count).toBe(3);
  });

  it("rejects an unknown query parameter instead of ignoring a typo", async () => {
    const app = await makeApp();
    const response = await read(app, "/v1/metrics/summary?payee=GSERVICEAAA&outcom=failed");
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/metrics/series", () => {
  it("puts a metric exactly on a bucket boundary in exactly one bucket", async () => {
    const app = await makeApp();
    await ingest(app, [
      metric({ amount: "10", at: "2026-06-26T10:00:00.000Z" }),
      metric({ amount: "20", at: "2026-06-26T11:00:00.000Z" }),
      metric({ amount: "40", at: "2026-06-26T12:00:00.000Z" }),
    ]);

    const response = await read(
      app,
      "/v1/metrics/series?from=2026-06-26T10:00:00.000Z&to=2026-06-26T12:00:00.000Z&bucket=1h",
    );
    expect(response.status).toBe(200);
    const series = (await response.json()) as {
      bucket: string;
      buckets: Array<{
        start: string;
        end: string;
        rows: Array<{ amount: string; settled: number }>;
      }>;
    };

    expect(series.bucket).toBe("1h");
    expect(series.buckets).toHaveLength(2);
    expect(series.buckets.map((bucket) => bucket.start)).toEqual([
      "2026-06-26T10:00:00.000Z",
      "2026-06-26T11:00:00.000Z",
    ]);
    expect(series.buckets.map((bucket) => bucket.rows.map((row) => row.amount))).toEqual([
      ["10"],
      ["20"],
    ]);
    // The 12:00 metric is exactly `to`, which is exclusive, so it is absent.
    expect(series.buckets.flatMap((bucket) => bucket.rows)).toHaveLength(2);
  });

  it("groups by payer when asked and returns latency percentiles", async () => {
    const app = await makeApp();
    await ingest(app, [
      metric({ payer: "GAGENT1", latencyMs: 10 }),
      metric({ payer: "GAGENT1", latencyMs: 20 }),
      metric({ payer: "GAGENT2", latencyMs: 30 }),
    ]);

    const series = (await (
      await read(
        app,
        "/v1/metrics/series?from=2026-06-26T10:00:00.000Z&to=2026-06-26T11:00:00.000Z&bucket=1h&groupBy=payer",
      )
    ).json()) as {
      groupBy: string;
      buckets: Array<{ rows: Array<{ payer?: string; latencyMs: { p50: number } }> }>;
    };

    expect(series.groupBy).toBe("payer");
    expect(series.buckets[0]?.rows.map((row) => row.payer)).toEqual(["GAGENT1", "GAGENT2"]);
    expect(series.buckets[0]?.rows[0]?.latencyMs.p50).toBe(10);
  });

  it("rejects a query without from and to", async () => {
    const app = await makeApp();
    const response = await read(app, "/v1/metrics/series?bucket=1h");
    expect(response.status).toBe(400);
  });

  it("rejects a range wider than the configured limit with a clear limit", async () => {
    const app = await makeApp({ limits: { maxRangeMs: 60 * 60 * 1000 } });
    const response = await read(
      app,
      "/v1/metrics/series?from=2026-06-26T00:00:00.000Z&to=2026-06-27T00:00:00.000Z&bucket=1h",
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "range-too-large", limit: { name: "maxRangeMs", value: 3600000 } },
    });
  });

  it("rejects a range that produces too many buckets", async () => {
    const limits: Partial<MetricsLimits> = { maxRangeMs: 90 * 24 * 60 * 60 * 1000 };
    const app = await makeApp({ limits });
    // Eleven days of one-minute buckets is 15840 buckets, past the hub's 10080.
    const response = await read(
      app,
      "/v1/metrics/series?from=2026-06-01T00:00:00.000Z&to=2026-06-12T00:00:00.000Z&bucket=1m",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; limit?: { name: string; value: number } };
    };
    expect(body.error.code).toBe("series-too-large");
    expect(body.error.limit?.name).toBe("buckets");
  });

  it("filters the series by asset and outcome", async () => {
    const app = await makeApp();
    await ingest(app, [
      metric({ asset: "USDC:GA5Z", amount: "1000" }),
      metric({ asset: "native", amount: "7" }),
      metric({ asset: "native", amount: "5", outcome: "failed" }),
    ]);

    const response = await read(
      app,
      "/v1/metrics/series?from=2026-06-26T10:00:00.000Z&to=2026-06-26T11:00:00.000Z&bucket=1h&asset=native&outcome=failed",
    );
    const series = (await response.json()) as {
      buckets: Array<{ rows: Array<{ asset: string; amount: string; failed: number }> }>;
    };
    expect(series.buckets[0]?.rows).toEqual([
      {
        model: "x402",
        asset: "native",
        amount: "0",
        settled: 0,
        failed: 1,
        skipped: 0,
        latencyMs: { p50: 42, p95: 42, p99: 42 },
      },
    ]);
  });
});

describe("GET /v1/metrics/export", () => {
  it("exports JSON as an attachment", async () => {
    const app = await makeApp({ now: () => Date.parse("2026-06-26T10:00:00.000Z") });
    await ingest(app, [metric({ amount: "1000" }), metric({ amount: "7", asset: "native" })]);

    const response = await read(app, "/v1/metrics/export?format=json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="tollway-metrics-2026-06-26T10-00-00-000Z.json"',
    );
    const exported = (await response.json()) as PaymentMetric[];
    expect(exported).toHaveLength(2);
  });

  it("exports CSV with the header row and an attachment name", async () => {
    const app = await makeApp({ now: () => Date.parse("2026-06-26T10:00:00.000Z") });
    await ingest(app, [metric({ amount: "1000" })]);

    const response = await read(app, "/v1/metrics/export?format=csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(".csv");
    const body = await response.text();
    const lines = body.split("\r\n");
    expect(lines[0]).toBe("payer,payee,model,amount,asset,latencyMs,outcome,at");
    expect(lines[1]).toContain('"1000"');
  });

  it("applies filters to the export", async () => {
    const app = await makeApp();
    await ingest(app, [metric({ asset: "USDC:GA5Z" }), metric({ asset: "native" })]);

    const response = await read(app, "/v1/metrics/export?format=json&asset=native");
    const exported = (await response.json()) as PaymentMetric[];
    expect(exported.map((entry) => entry.asset)).toEqual(["native"]);
  });

  it("rejects an export bigger than the configured row limit", async () => {
    const app = await makeApp({ limits: { maxExportRows: 1 } });
    await ingest(app, [metric(), metric({ amount: "2" })]);

    const response = await read(app, "/v1/metrics/export?format=json");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "export-too-large", limit: { name: "maxExportRows", value: 1 } },
    });
  });

  it("rejects a missing or unknown format", async () => {
    const app = await makeApp();
    expect((await read(app, "/v1/metrics/export")).status).toBe(400);
    expect((await read(app, "/v1/metrics/export?format=xml")).status).toBe(400);
  });
});

describe("service error handling", () => {
  it("answers an unexpected store failure with 500 and reports it without leaking the cause", async () => {
    const onError = vi.fn();
    const failing: MetricsStore = {
      record: () => undefined,
      summarize: () => {
        throw new Error("/srv/secret/path: disk on fire");
      },
      timeseries: () => {
        throw new Error("unreachable");
      },
      export: () => "unreachable",
    };
    const app = await makeApp({ store: failing, onError });

    const response = await read(app, "/v1/metrics/summary");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal-error");
    expect(body.error.message).not.toContain("disk on fire");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "/srv/secret/path: disk on fire" }),
    );
  });

  it("refuses invalid limits at construction instead of failing on the first query", async () => {
    await expect(makeApp({ limits: { maxRangeMs: 0 } })).rejects.toThrow(/positive integer/);
  });
});
