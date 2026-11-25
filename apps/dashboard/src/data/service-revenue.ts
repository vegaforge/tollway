/**
 * Typed data layer for the services view (`/services`).
 *
 * A service is a payee: the Stellar address a paid route settles to. For each
 * payee and asset the view shows settled revenue, the number of settled
 * payments, the settlement model mix, and the average latency per model.
 *
 * Revenue and counts come from the hub's own `summarizeAsync`, which counts
 * only settled payments and never adds one asset to another. Latency comes
 * from the same hub's `queryMetrics`, because a spend summary carries no
 * latency. Today the hub is filled from deterministic stub payments; pointing
 * `fetchServiceRevenue` at the real hub changes nothing downstream.
 *
 * See docs/design.md, "Observability", and docs/dashboard-data-contracts.md.
 */

import { settlementModels } from "@vegaforge/tollway-core";
import {
  createObservabilityHub,
  type MetricsQuery,
  type ObservabilityHub,
  type PaymentMetric,
} from "@vegaforge/tollway-observability";

type SettlementModel = PaymentMetric["model"];

/** One settlement model's share of a service's settled payments. */
export type ServiceModelStats = {
  model: SettlementModel;
  /** Settled payments through this model. */
  count: number;
  /**
   * Mean latency of the settled payments through this model, in whole
   * milliseconds, or null when the model settled nothing.
   */
  avgLatencyMs: number | null;
};

/**
 * One row in the services table: one payee in one asset. Amounts in
 * different assets are never added, so a payee paid in two assets has two
 * rows.
 */
export type ServiceRevenueRow = {
  /** `<payee>:<asset>`, stable across loads, used as the React key. */
  id: string;
  /** The payee address. */
  payee: string;
  /** A human name for the payee, or the address when none is known. */
  label: string;
  /** Asset identifier exactly as the metrics carry it. */
  asset: string;
  /** Settled revenue, an integer string in the asset's smallest unit. */
  revenue: string;
  /** Settled payments behind `revenue`. */
  count: number;
  /** Every settlement model, in `settlementModels` order, including ones with no payments. */
  models: ServiceModelStats[];
};

export type ServiceRevenueSnapshot = {
  /** The window the figures cover, inclusive at both ends, in UTC. */
  period: { from: string; to: string };
  rows: ServiceRevenueRow[];
};

/** The part of the hub this module reads. */
export type ServiceRevenueSource = Pick<ObservabilityHub, "summarizeAsync" | "queryMetrics">;

/**
 * Builds the services snapshot from a hub. Exported so tests can feed it
 * their own metrics; the page goes through `fetchServiceRevenue`.
 */
export async function serviceRevenueFrom(
  source: ServiceRevenueSource,
  period: { from: string; to: string },
  labels: Readonly<Record<string, string>>,
): Promise<ServiceRevenueSnapshot> {
  const window: MetricsQuery = { from: period.from, to: period.to };
  const summary = await source.summarizeAsync(window);

  const rows: ServiceRevenueRow[] = [];
  for (const entry of summary.byPayeeAsset) {
    const scope: MetricsQuery = { ...window, payee: entry.payee, asset: entry.asset };
    const [scoped, latency] = await Promise.all([
      source.summarizeAsync(scope),
      settledLatencyByModel(source, scope),
    ]);
    rows.push({
      id: `${entry.payee}:${entry.asset}`,
      payee: entry.payee,
      label: labels[entry.payee] ?? entry.payee,
      asset: entry.asset,
      revenue: entry.amount,
      count: entry.count,
      models: settlementModels.map((model) => ({
        model,
        count: scoped.byModelAsset.find((m) => m.model === model)?.count ?? 0,
        avgLatencyMs: latency.get(model) ?? null,
      })),
    });
  }
  return { period, rows };
}

/** Mean settled latency per model, reading every page the hub returns. */
async function settledLatencyByModel(
  source: ServiceRevenueSource,
  query: MetricsQuery,
): Promise<Map<SettlementModel, number>> {
  const totals = new Map<SettlementModel, { sum: number; count: number }>();
  let cursor: string | undefined;
  do {
    const page = await source.queryMetrics(
      { ...query, outcome: "settled" },
      cursor === undefined ? {} : { cursor },
    );
    for (const metric of page.metrics) {
      const total = totals.get(metric.model) ?? { sum: 0, count: 0 };
      total.sum += metric.latencyMs;
      total.count += 1;
      totals.set(metric.model, total);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  const means = new Map<SettlementModel, number>();
  for (const [model, { sum, count }] of totals) {
    means.set(model, Math.round(sum / count));
  }
  return means;
}

/**
 * The single seam between the services view and the observability hub.
 * Swap the stub hub for the real one and leave the signature alone.
 */
export async function fetchServiceRevenue(): Promise<ServiceRevenueSnapshot> {
  const hub = createObservabilityHub();
  for (const metric of STUB_PAYMENTS) hub.record(metric);
  return serviceRevenueFrom(hub, STUB_PERIOD, STUB_LABELS);
}

// ── stub data ─────────────────────────────────────────────────────────────────
//
// Three services, two assets, all three models, every outcome, and a service
// that uses one model only, so the mix shows zero shares rather than gaps.

const STUB_PERIOD = {
  from: "2026-11-17T00:00:00.000Z",
  to: "2026-11-24T23:59:59.999Z",
} as const;

const PAYER = "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const WEATHER = "GCWEATHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const GEOCODE = "GCGEOCODEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const INFERENCE = "GCINFERENCEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const STUB_LABELS: Readonly<Record<string, string>> = {
  [WEATHER]: "Weather API",
  [GEOCODE]: "Geocoding",
  [INFERENCE]: "Inference gateway",
};

function payment(
  model: SettlementModel,
  payee: string,
  asset: string,
  outcome: PaymentMetric["outcome"],
  amount: string,
  latencyMs: number,
  at: string,
): PaymentMetric {
  return { payer: PAYER, payee, model, asset, outcome, amount, latencyMs, at };
}

const STUB_PAYMENTS: PaymentMetric[] = [
  payment("x402", WEATHER, "USDC", "settled", "1200000", 118, "2026-11-18T10:00:00.000Z"),
  payment("x402", WEATHER, "USDC", "settled", "1200000", 122, "2026-11-19T10:00:00.000Z"),
  payment("mpp-charge", WEATHER, "USDC", "settled", "2500000", 64, "2026-11-20T10:00:00.000Z"),
  payment("mpp-channel", WEATHER, "USDC", "settled", "40000000", 21, "2026-11-21T10:00:00.000Z"),
  payment("x402", WEATHER, "USDC", "failed", "1200000", 900, "2026-11-21T11:00:00.000Z"),
  payment("x402", GEOCODE, "USDC", "settled", "500000", 96, "2026-11-19T08:00:00.000Z"),
  payment("x402", GEOCODE, "USDC", "settled", "500000", 104, "2026-11-22T08:00:00.000Z"),
  payment("x402", GEOCODE, "USDC", "settled", "500000", 100, "2026-11-23T08:00:00.000Z"),
  payment("mpp-channel", INFERENCE, "USDC", "settled", "85000000", 410, "2026-11-22T09:00:00.000Z"),
  payment("mpp-channel", INFERENCE, "USDC", "settled", "41000000", 390, "2026-11-23T09:00:00.000Z"),
  payment("mpp-charge", INFERENCE, "USDC", "skipped", "7500000", 0, "2026-11-23T10:00:00.000Z"),
  payment("x402", INFERENCE, "XLM", "settled", "30000000", 640, "2026-11-22T12:00:00.000Z"),
  payment("x402", INFERENCE, "XLM", "settled", "12500000", 660, "2026-11-24T04:00:00.000Z"),
];
