import type { PaymentMetric } from "@vegaforge/tollway-observability";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type MetricsModuleOptions, metricsModule } from "./metrics.js";
import type { OpenApiDocument } from "./openapi.js";
import { createMemoryMetricsStore, type MetricsStore } from "./stores.js";
import { bearer, KEYS, testService } from "./test-support.js";
import type { ServiceEnv } from "./types.js";

type App = Hono<ServiceEnv>;

async function makeApp(
  options: MetricsModuleOptions = {},
  metrics: MetricsStore = createMemoryMetricsStore(),
) {
  return testService({ modules: [metricsModule(options)], stores: { metrics } });
}

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: "GAGENTAAA",
    payee: "GSERVICEAAA",
    model: "x402",
    amount: "1000",
    asset: "USDC:GA5Z",
    latencyMs: 42,
    outcome: "settled",
    at: "2026-06-26T10:00:00.000Z",
    ...overrides,
  };
}

function post(app: App, body: unknown, key: string = KEYS.ingester): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/metrics", {
      method: "POST",
      headers: { ...bearer(key), "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function ingest(app: App, metrics: PaymentMetric[]): Promise<Response> {
  return post(app, { metrics });
}

function read(app: App, path: string, key: string = KEYS.reader): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: bearer(key) }));
}

describe("metrics routes: scopes and OpenAPI", () => {
  it("lists every metrics route in /openapi.json with its scope and schemas", async () => {
    const { app } = await makeApp();
    const document = (await (await app.request("/openapi.json")).json()) as OpenApiDocument;
    const ingestRoute = document.paths["/v1/metrics"]?.post as Record<string, unknown>;
    expect(ingestRoute["x-tollway-scope"]).toBe("ingest");
    expect(ingestRoute.requestBody).toBeDefined();
    for (const path of ["/v1/metrics/summary", "/v1/metrics/series", "/v1/metrics/export"]) {
      const route = document.paths[path]?.get as Record<string, unknown>;
      expect(route["x-tollway-scope"]).toBe("read");
      expect(route.parameters).toEqual(expect.arrayContaining([expect.anything()]));
    }
  });

  it("refuses a read key on ingest and an ingest key on read", async () => {
    const { app } = await makeApp();
    expect((await post(app, { metrics: [metric()] }, KEYS.reader)).status).toBe(403);
    expect((await read(app, "/v1/metrics/summary", KEYS.ingester)).status).toBe(403);
    expect((await app.request("/v1/metrics/summary")).status).toBe(401);
  });
});

describe("POST /v1/metrics", () => {
  it("records every metric in the batch", async () => {
    const { app } = await makeApp();
    const response = await ingest(app, [metric(), metric({ outcome: "failed", amount: "500" })]);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2 });
    const summary = (await (await read(app, "/v1/metrics/summary")).json()) as { count: number };
    expect(summary.count).toBe(2);
  });

  it("refuses a body that is not the ingest object, malformed JSON, and an empty batch", async () => {
    const { app } = await makeApp();
    for (const body of [[metric()], "{", { metrics: [] }]) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid-request" } });
    }
  });

  it.each([
    ["a decimal amount", { amount: "1.5" }],
    ["an empty asset", { asset: "" }],
    ["a timestamp without a zone", { at: "2026-06-26T10:00:00" }],
    ["a negative latency", { latencyMs: -1 }],
    ["an unknown field", { extra: "no" }],
  ])("refuses %s, naming the field", async (_name, overrides) => {
    const { app } = await makeApp();
    const response = await post(app, { metrics: [{ ...metric(), ...overrides }] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: unknown[] } };
    expect(body.error.details.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/metrics/summary", () => {
  it("returns settled totals per asset and counts per outcome, with no cross-asset total", async () => {
    const { app } = await makeApp();
    await ingest(app, [
      metric({ amount: "1000" }),
      metric({ amount: "250", model: "mpp-charge" }),
      metric({ amount: "500", outcome: "failed" }),
      metric({ amount: "7", asset: "native" }),
      metric({ amount: "3", asset: "native", outcome: "skipped" }),
    ]);

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

  it("filters by asset, outcome and time range", async () => {
    const { app } = await makeApp();
    await ingest(app, [
      metric({ amount: "1000", at: "2026-06-26T09:00:00.000Z" }),
      metric({ amount: "10", asset: "native" }),
      metric({ amount: "5", asset: "native", outcome: "failed" }),
    ]);

    expect(await (await read(app, "/v1/metrics/summary?asset=native")).json()).toMatchObject({
      count: 2,
      byAsset: [{ asset: "native", amount: "10" }],
    });
    expect(await (await read(app, "/v1/metrics/summary?outcome=failed")).json()).toMatchObject({
      count: 1,
      byAsset: [],
      byOutcome: { failed: 1 },
    });
    const ranged = (await (
      await read(app, "/v1/metrics/summary?from=2026-06-26T09:30:00.000Z&to=2026-06-26T11:00:00Z")
    ).json()) as { count: number };
    expect(ranged.count).toBe(2);
  });

  it("refuses an unknown query parameter instead of ignoring a typo", async () => {
    const { app } = await makeApp();
    expect((await read(app, "/v1/metrics/summary?outcom=failed")).status).toBe(400);
  });

  it("refuses a range wider than the limit, naming the limit", async () => {
    const { app } = await makeApp({ limits: { maxRangeMs: 3_600_000 } });
    const response = await read(
      app,
      "/v1/metrics/summary?from=2026-06-26T00:00:00Z&to=2026-06-27T00:00:00Z",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "range-too-large",
        details: { limit: { name: "maxRangeMs", value: 3_600_000 } },
      },
    });
  });
});

describe("GET /v1/metrics/series", () => {
  const range = "from=2026-06-26T10:00:00.000Z&to=2026-06-26T12:00:00.000Z";

  it("puts a metric exactly on a bucket boundary in exactly one bucket, and treats to as exclusive", async () => {
    const { app } = await makeApp();
    await ingest(app, [
      metric({ amount: "10", at: "2026-06-26T10:00:00.000Z" }),
      metric({ amount: "20", at: "2026-06-26T11:00:00.000Z" }),
      metric({ amount: "40", at: "2026-06-26T12:00:00.000Z" }),
    ]);
    const response = await read(app, `/v1/metrics/series?${range}&bucket=1h`);
    expect(response.status).toBe(200);
    const series = (await response.json()) as {
      buckets: Array<{ start: string; rows: Array<{ amount: string }> }>;
    };
    expect(series.buckets.map((bucket) => bucket.start)).toEqual([
      "2026-06-26T10:00:00.000Z",
      "2026-06-26T11:00:00.000Z",
    ]);
    expect(series.buckets.map((bucket) => bucket.rows.map((row) => row.amount))).toEqual([
      ["10"],
      ["20"],
    ]);
  });

  it("groups by payer and reports latency percentiles", async () => {
    const { app } = await makeApp();
    await ingest(app, [
      metric({ payer: "GAGENT1", latencyMs: 10 }),
      metric({ payer: "GAGENT1", latencyMs: 20 }),
      metric({ payer: "GAGENT2", latencyMs: 30 }),
    ]);
    const series = (await (
      await read(app, `/v1/metrics/series?${range}&bucket=1h&groupBy=payer`)
    ).json()) as {
      groupBy: string;
      buckets: Array<{ rows: Array<{ payer?: string; latencyMs: { p50: number } | null }> }>;
    };
    expect(series.groupBy).toBe("payer");
    expect(series.buckets[0]?.rows.map((row) => row.payer)).toEqual(["GAGENT1", "GAGENT2"]);
    expect(series.buckets[0]?.rows[0]?.latencyMs?.p50).toBe(10);
  });

  it("filters by asset and outcome", async () => {
    const { app } = await makeApp();
    await ingest(app, [
      metric({ amount: "1000" }),
      metric({ asset: "native", amount: "7" }),
      metric({ asset: "native", amount: "5", outcome: "failed" }),
    ]);
    const series = (await (
      await read(app, `/v1/metrics/series?${range}&bucket=1h&asset=native&outcome=failed`)
    ).json()) as { buckets: Array<{ rows: unknown[] }> };
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

  it("refuses a query without a range, and a range that is backwards", async () => {
    const { app } = await makeApp();
    expect((await read(app, "/v1/metrics/series?bucket=1h")).status).toBe(400);
    const backwards = await read(
      app,
      "/v1/metrics/series?from=2026-06-26T12:00:00Z&to=2026-06-26T10:00:00Z&bucket=1h",
    );
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toMatchObject({ error: { code: "invalid-request" } });
  });

  it("refuses a range that needs more buckets than the store allows, naming the limit", async () => {
    const { app } = await makeApp();
    // Eleven days of one-minute buckets is 15 840, past the hub's 10 080.
    const response = await read(
      app,
      "/v1/metrics/series?from=2026-06-01T00:00:00Z&to=2026-06-12T00:00:00Z&bucket=1m",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "series-too-large", details: { limit: { name: "buckets", value: 10_080 } } },
    });
  });
});

describe("GET /v1/metrics/export", () => {
  const now = () => Date.parse("2026-06-26T10:00:00.000Z");

  it("exports JSON as an attachment", async () => {
    const { app } = await makeApp({ now });
    await ingest(app, [metric(), metric({ amount: "7", asset: "native" })]);
    const response = await read(app, "/v1/metrics/export?format=json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="tollway-metrics-2026-06-26T10-00-00-000Z.json"',
    );
    expect((await response.json()) as unknown[]).toHaveLength(2);
  });

  it("exports CSV with the header row", async () => {
    const { app } = await makeApp({ now });
    await ingest(app, [metric()]);
    const response = await read(app, "/v1/metrics/export?format=csv");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(".csv");
    const lines = (await response.text()).split("\r\n");
    expect(lines[0]).toBe("payer,payee,model,amount,asset,latencyMs,outcome,at");
    expect(lines[1]).toContain('"1000"');
  });

  it("applies the filters", async () => {
    const { app } = await makeApp();
    await ingest(app, [metric(), metric({ asset: "native" })]);
    const exported = (await (
      await read(app, "/v1/metrics/export?format=json&asset=native")
    ).json()) as PaymentMetric[];
    expect(exported.map((entry) => entry.asset)).toEqual(["native"]);
  });

  it("refuses an export bigger than the row limit, and a missing or unknown format", async () => {
    const { app } = await makeApp({ limits: { maxExportRows: 1 } });
    await ingest(app, [metric(), metric({ amount: "2" })]);
    const response = await read(app, "/v1/metrics/export?format=json");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "export-too-large", details: { limit: { name: "maxExportRows", value: 1 } } },
    });
    expect((await read(app, "/v1/metrics/export")).status).toBe(400);
    expect((await read(app, "/v1/metrics/export?format=xml")).status).toBe(400);
  });
});

describe("metrics module failures", () => {
  it("answers a store failure with 500 and logs it without returning the cause", async () => {
    const failing: MetricsStore = {
      ...createMemoryMetricsStore(),
      summarize: () => Promise.reject(new Error("/srv/secret/path: disk on fire")),
    };
    const { app, logger } = await makeApp({}, failing);
    const response = await read(app, "/v1/metrics/summary");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal-error");
    expect(JSON.stringify(body)).not.toContain("disk on fire");
    expect(JSON.stringify(logger.lines)).toContain("disk on fire");
  });

  it("refuses an invalid limit when the module is created", () => {
    expect(() => metricsModule({ limits: { maxRangeMs: 0 } })).toThrow(/positive integer/);
    expect(() => metricsModule({ limits: { maxExportRows: 1.5 } })).toThrow(/positive integer/);
  });
});
