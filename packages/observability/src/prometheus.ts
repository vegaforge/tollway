import type { DeliveryOutcome, ObservabilityHub } from "./index.js";
import type { PaymentMetric } from "./metrics.js";

/**
 * A Prometheus exporter for the observability hub (#218). It renders the
 * text exposition format 0.0.4 by hand, so the package gains no dependency.
 *
 * Every counter is kept here and updated as the hub records a metric or a
 * delivery finishes, so counters only ever go up and do not depend on how
 * much history a metrics store keeps. They count from the moment the
 * exporter is created, like any per-process Prometheus counter.
 */

/** Latency histogram buckets, in seconds. */
export const DEFAULT_LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export type PrometheusExporterOptions = {
  hub: ObservabilityHub;
  /**
   * Payees that may appear as a `payee` label on the payment counters. By
   * default no payer or payee is ever a label: addresses are unbounded and
   * would leak counterparties to whoever can scrape. Payees not listed are
   * reported as `payee="other"`.
   */
  labelAllowlist?: { payee?: readonly string[] };
  /**
   * When set, a scrape must send `Authorization: Bearer <token>`. The
   * comparison takes the same time whatever the guess.
   */
  bearerToken?: string;
  /** Histogram buckets in seconds, ascending. Defaults to {@link DEFAULT_LATENCY_BUCKETS_SECONDS}. */
  latencyBucketsSeconds?: readonly number[];
};

/** The parts of an HTTP request the handler reads. */
export type PrometheusRequest = {
  headers: Headers | Record<string, string | string[] | undefined>;
};

export type PrometheusResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type PrometheusExporter = {
  /** Renders the current metrics. Framework-agnostic: map the result to your response. */
  handle(request: PrometheusRequest): PrometheusResponse;
  /** The exposition text without the HTTP wrapping, for tests and push setups. */
  render(): string;
  /** Stops counting. The counters keep their values. */
  detach(): void;
};

const CONTENT_TYPE = "text/plain; version=0.0.4";

type Labels = Record<string, string>;

/** A counter family keyed by its rendered label set. */
class Counter {
  private readonly values = new Map<string, { labels: Labels; value: bigint }>();

  inc(labels: Labels, by: bigint = 1n): void {
    const key = labelKey(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels, value: by });
  }

  entries(): Array<{ labels: Labels; value: bigint }> {
    return [...this.values.values()].sort((a, b) =>
      labelKey(a.labels) < labelKey(b.labels) ? -1 : 1,
    );
  }
}

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();

  constructor(readonly bounds: readonly number[]) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.bounds.forEach((bound, index) => {
      if (value <= bound && entry) entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  entries() {
    return [...this.series.values()].sort((a, b) =>
      labelKey(a.labels) < labelKey(b.labels) ? -1 : 1,
    );
  }
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join("\u0000");
}

/** Escapes a label value: backslash, double quote and newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "";
  return `{${names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`).join(",")}}`;
}

/** Formats a sample value as Prometheus reads it. */
function sample(value: number | bigint): string {
  if (typeof value === "bigint") {
    // Prometheus samples are float64, exact only up to 2^53. The amount
    // counter is documented as approximate above that; never use it for
    // accounting.
    return Number(value).toString();
  }
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return value.toString();
}

function headerValue(headers: PrometheusRequest["headers"], name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Compares two strings in time that depends only on their lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function assertBuckets(bounds: readonly number[]): void {
  if (bounds.length === 0) throw new RangeError("latencyBucketsSeconds must not be empty");
  bounds.forEach((bound, index) => {
    if (!Number.isFinite(bound) || bound <= 0) {
      throw new RangeError(`latency bucket ${bound} must be a positive finite number`);
    }
    const previous = bounds[index - 1];
    if (previous !== undefined && bound <= previous) {
      throw new RangeError("latencyBucketsSeconds must be strictly ascending");
    }
  });
}

/**
 * Creates the exporter and starts counting the hub's metrics and deliveries.
 * Mount `handle` on whatever route your scraper reads, usually `/metrics`.
 */
export function createPrometheusExporter(options: PrometheusExporterOptions): PrometheusExporter {
  if (options.bearerToken !== undefined && options.bearerToken.length === 0) {
    throw new TypeError("bearerToken must not be empty; omit it to serve without a token");
  }
  const bounds = options.latencyBucketsSeconds ?? DEFAULT_LATENCY_BUCKETS_SECONDS;
  assertBuckets(bounds);
  const allowedPayees = new Set(options.labelAllowlist?.payee ?? []);
  const payeeLabel = allowedPayees.size > 0;

  const payments = new Counter();
  const amounts = new Counter();
  const latency = new Histogram(bounds);
  const deliveries = new Counter();
  const deliveryFailures = new Counter();

  function paymentLabels(metric: PaymentMetric, extra: Labels): Labels {
    if (!payeeLabel) return extra;
    return { ...extra, payee: allowedPayees.has(metric.payee) ? metric.payee : "other" };
  }

  function onMetric(metric: PaymentMetric): void {
    payments.inc(
      paymentLabels(metric, { model: metric.model, outcome: metric.outcome, asset: metric.asset }),
    );
    // Only settled payments moved money. An amount that is not an integer
    // string is left out of the amount counter rather than guessed at; the
    // payment itself is still counted above.
    if (metric.outcome === "settled" && /^[0-9]+$/.test(metric.amount)) {
      amounts.inc(
        paymentLabels(metric, { model: metric.model, asset: metric.asset }),
        BigInt(metric.amount),
      );
    }
    if (Number.isFinite(metric.latencyMs) && metric.latencyMs >= 0) {
      latency.observe({ model: metric.model, outcome: metric.outcome }, metric.latencyMs / 1000);
    }
  }

  function onDelivery(outcome: DeliveryOutcome): void {
    if (outcome.targetKind === "webhook") deliveries.inc({ result: outcome.result });
    if (outcome.result === "failed") deliveryFailures.inc({ target_kind: outcome.targetKind });
  }

  const detach = options.hub.observe({ onMetric, onDelivery });

  function render(): string {
    const lines: string[] = [];
    const family = (name: string, type: string, help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    family(
      "tollway_payments_total",
      "counter",
      "Payments recorded, by settlement model, outcome and asset.",
    );
    for (const { labels, value } of payments.entries()) {
      lines.push(`tollway_payments_total${renderLabels(labels)} ${sample(value)}`);
    }

    family(
      "tollway_payment_amount_base_units_total",
      "counter",
      "Settled amount in the asset's smallest unit. Approximate above 2^53; not for accounting.",
    );
    for (const { labels, value } of amounts.entries()) {
      lines.push(`tollway_payment_amount_base_units_total${renderLabels(labels)} ${sample(value)}`);
    }

    family(
      "tollway_payment_latency_seconds",
      "histogram",
      "Payment latency, by settlement model and outcome.",
    );
    for (const entry of latency.entries()) {
      entry.buckets.forEach((count, index) => {
        const le = sample(latency.bounds[index] as number);
        lines.push(
          `tollway_payment_latency_seconds_bucket${renderLabels({ ...entry.labels, le })} ${count}`,
        );
      });
      lines.push(
        `tollway_payment_latency_seconds_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${entry.count}`,
        `tollway_payment_latency_seconds_sum${renderLabels(entry.labels)} ${sample(entry.sum)}`,
        `tollway_payment_latency_seconds_count${renderLabels(entry.labels)} ${entry.count}`,
      );
    }

    family(
      "tollway_webhook_deliveries_total",
      "counter",
      "Webhook deliveries that finished, by result.",
    );
    for (const { labels, value } of deliveries.entries()) {
      lines.push(`tollway_webhook_deliveries_total${renderLabels(labels)} ${sample(value)}`);
    }

    family(
      "tollway_webhook_delivery_failures_total",
      "counter",
      "Deliveries that exhausted their attempts, by target kind (handler or webhook).",
    );
    for (const { labels, value } of deliveryFailures.entries()) {
      lines.push(`tollway_webhook_delivery_failures_total${renderLabels(labels)} ${sample(value)}`);
    }

    return `${lines.join("\n")}\n`;
  }

  return {
    handle(request): PrometheusResponse {
      if (options.bearerToken !== undefined) {
        const header = headerValue(request.headers, "authorization") ?? "";
        const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        if (!constantTimeEqual(token, options.bearerToken)) {
          return {
            status: 401,
            headers: { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Bearer" },
            body: "unauthorized\n",
          };
        }
      }
      return { status: 200, headers: { "content-type": CONTENT_TYPE }, body: render() };
    },
    render,
    detach,
  };
}
