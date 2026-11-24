import { describe, expect, it, vi } from "vitest";
import { createObservabilityHub, type PaymentMetric, type TollwayEvent } from "./index.js";
import { createPrometheusExporter } from "./prometheus.js";

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: "GPAYER",
    payee: "GSERVICE",
    model: "x402",
    amount: "100",
    asset: "USDC:GA5Z",
    latencyMs: 40,
    outcome: "settled",
    at: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

type Sample = { name: string; labels: Record<string, string>; value: string };
type Family = { help: string; type: string; samples: Sample[] };

/**
 * A small parser for the text exposition format, enough to check the
 * structure the exporter writes: HELP and TYPE before samples, escaped label
 * values, and one family per metric name.
 */
function parse(text: string): Map<string, Family> {
  const families = new Map<string, Family>();
  let current: Family | undefined;
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) {
    const help = /^# HELP (\S+) (.*)$/.exec(line);
    if (help) {
      current = { help: help[2] as string, type: "", samples: [] };
      families.set(help[1] as string, current);
      continue;
    }
    const type = /^# TYPE (\S+) (counter|histogram|gauge)$/.exec(line);
    if (type) {
      expect(current).toBeDefined();
      if (current) current.type = type[2] as string;
      continue;
    }
    const sample = /^([a-z_]+)(?:\{(.*)\})? (\S+)$/.exec(line);
    expect(sample, `unparseable line: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    const labelPattern = /([a-z_]+)="((?:[^"\\]|\\.)*)"/g;
    for (const match of (sample?.[2] ?? "").matchAll(labelPattern)) {
      labels[match[1] as string] = (match[2] as string)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    current?.samples.push({ name: sample?.[1] as string, labels, value: sample?.[3] as string });
  }
  return families;
}

function value(family: Family | undefined, name: string, labels: Record<string, string>): string {
  const found = family?.samples.find(
    (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  expect(found, `${name} ${JSON.stringify(labels)}`).toBeDefined();
  return found?.value as string;
}

describe("Prometheus exporter", () => {
  it("renders the documented families as text format 0.0.4", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub });
    hub.record(metric());
    hub.record(metric({ amount: "50", latencyMs: 300 }));
    hub.record(metric({ outcome: "failed", amount: "999", latencyMs: 12_000 }));

    const response = exporter.handle({ headers: {} });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; version=0.0.4");
    const families = parse(response.body);
    expect([...families.keys()]).toEqual([
      "tollway_payments_total",
      "tollway_payment_amount_base_units_total",
      "tollway_payment_latency_seconds",
      "tollway_webhook_deliveries_total",
      "tollway_webhook_delivery_failures_total",
    ]);
    expect(families.get("tollway_payment_latency_seconds")?.type).toBe("histogram");

    const payments = families.get("tollway_payments_total");
    expect(value(payments, "tollway_payments_total", { outcome: "settled" })).toBe("2");
    expect(value(payments, "tollway_payments_total", { outcome: "failed" })).toBe("1");
    // Only settled payments moved money.
    expect(
      value(
        families.get("tollway_payment_amount_base_units_total"),
        "tollway_payment_amount_base_units_total",
        {
          asset: "USDC:GA5Z",
        },
      ),
    ).toBe("150");
  });

  it("writes cumulative buckets ending in +Inf, with _sum and _count", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub, latencyBucketsSeconds: [0.1, 1] });
    hub.record(metric({ latencyMs: 50 }));
    hub.record(metric({ latencyMs: 500 }));
    hub.record(metric({ latencyMs: 5000 }));
    const histogram = parse(exporter.render()).get("tollway_payment_latency_seconds");
    const bucket = (le: string) =>
      value(histogram, "tollway_payment_latency_seconds_bucket", { outcome: "settled", le });
    expect([bucket("0.1"), bucket("1"), bucket("+Inf")]).toEqual(["1", "2", "3"]);
    expect(value(histogram, "tollway_payment_latency_seconds_count", { outcome: "settled" })).toBe(
      "3",
    );
    expect(value(histogram, "tollway_payment_latency_seconds_sum", { outcome: "settled" })).toBe(
      "5.55",
    );
  });

  it("never labels a payer or payee by default", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub });
    hub.record(metric());
    const text = exporter.render();
    expect(text).not.toContain("GPAYER");
    expect(text).not.toContain("GSERVICE");
    expect(text).not.toMatch(/payee=|payer=/);
  });

  it("labels allowlisted payees and folds the rest into other", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub, labelAllowlist: { payee: ["GKNOWN"] } });
    hub.record(metric({ payee: "GKNOWN" }));
    hub.record(metric({ payee: "GSTRANGER" }));
    const payments = parse(exporter.render()).get("tollway_payments_total");
    expect(value(payments, "tollway_payments_total", { payee: "GKNOWN" })).toBe("1");
    expect(value(payments, "tollway_payments_total", { payee: "other" })).toBe("1");
    expect(exporter.render()).not.toContain("GSTRANGER");
  });

  it.each([
    ["a backslash", "A\\B"],
    ["a double quote", 'A"B'],
    ["a newline", "A\nB"],
  ])("escapes %s in a label value", (_name, asset) => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub });
    hub.record(metric({ asset }));
    const payments = parse(exporter.render()).get("tollway_payments_total");
    expect(value(payments, "tollway_payments_total", { asset })).toBe("1");
  });

  it("keeps counters monotonic over many records, whatever the store keeps", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub });
    let previous = 0;
    for (let round = 1; round <= 50; round += 1) {
      for (let i = 0; i < 20; i += 1) hub.record(metric());
      const now = Number(
        value(parse(exporter.render()).get("tollway_payments_total"), "tollway_payments_total", {}),
      );
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
    expect(previous).toBe(1000);
  });

  it("counts a failed webhook delivery and a successful one", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("no", { status: 500 }));
    const hub = createObservabilityHub({
      fetch: fetcher,
      retry: { maxAttempts: 1 },
      sleep: async () => undefined,
      webhooks: [{ url: "https://example.invalid/a" }],
    });
    const exporter = createPrometheusExporter({ hub });
    const event: TollwayEvent = {
      id: "evt-1",
      type: "receipt.created",
      at: "2026-11-20T10:00:00.000Z",
      data: {},
    };
    await hub.emit(event);
    await hub.emit({ ...event, id: "evt-2" });
    const families = parse(exporter.render());
    const deliveries = families.get("tollway_webhook_deliveries_total");
    expect(value(deliveries, "tollway_webhook_deliveries_total", { result: "delivered" })).toBe(
      "1",
    );
    expect(value(deliveries, "tollway_webhook_deliveries_total", { result: "failed" })).toBe("1");
    expect(
      value(
        families.get("tollway_webhook_delivery_failures_total"),
        "tollway_webhook_delivery_failures_total",
        {
          target_kind: "webhook",
        },
      ),
    ).toBe("1");
  });

  it("refuses a scrape without the bearer token, and accepts the right one", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub, bearerToken: "s3cret" });
    expect(exporter.handle({ headers: {} }).status).toBe(401);
    expect(exporter.handle({ headers: { authorization: "Bearer wrong" } }).status).toBe(401);
    expect(exporter.handle({ headers: { authorization: "Bearer s3cret-longer" } }).status).toBe(
      401,
    );
    expect(exporter.handle({ headers: { Authorization: "Bearer s3cret" } }).status).toBe(200);
    expect(
      exporter.handle({ headers: new Headers({ authorization: "Bearer s3cret" }) }).status,
    ).toBe(200);
  });

  it("stops counting once detached, keeping the values it has", () => {
    const hub = createObservabilityHub();
    const exporter = createPrometheusExporter({ hub });
    hub.record(metric());
    exporter.detach();
    hub.record(metric());
    const payments = parse(exporter.render()).get("tollway_payments_total");
    expect(value(payments, "tollway_payments_total", {})).toBe("1");
  });

  it.each([
    [[]],
    [[1, 0.5]],
    [[0]],
    [[Number.POSITIVE_INFINITY]],
  ])("refuses latency buckets %o", (buckets) => {
    expect(() =>
      createPrometheusExporter({ hub: createObservabilityHub(), latencyBucketsSeconds: buckets }),
    ).toThrow(RangeError);
  });
});
