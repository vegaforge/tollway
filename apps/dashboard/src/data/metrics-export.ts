/**
 * Typed data layer for the exports view.
 *
 * The exports view (src/app/(dashboard)/exports/page.tsx) consumes
 * @vegaforge/tollway-observability's `export()` and `summarize()` primitives.
 * Until the dashboard reads from a live observability backend (#106), this
 * module supplies a deterministic ObservabilityHub seeded with stub
 * PaymentMetric records so range filtering, JSON/CSV serialization, and CSV
 * formula-injection escaping execute against the real package implementation.
 *
 * See docs/design.md, "Observability".
 */

import {
  createObservabilityHub,
  type ExportFormat,
  type MetricsQuery,
  type ObservabilityHub,
  type PaymentMetric,
} from "@vegaforge/tollway-observability";

/** Minimal hub surface required by the exports view. */
export type MetricsExportSource = Pick<ObservabilityHub, "export" | "summarize">;

/** Snapshot returned by the exports data source. */
export type MetricsExportSnapshot = {
  hub: MetricsExportSource;
  /** Default inclusive start date (`YYYY-MM-DD`, UTC). */
  defaultFrom: string;
  /** Default inclusive end date (`YYYY-MM-DD`, UTC). */
  defaultTo: string;
};

/** Default inclusive start date matching the stub metrics window (UTC). */
export const DEFAULT_EXPORT_FROM = "2026-11-13";

/** Default inclusive end date matching the stub metrics window (UTC). */
export const DEFAULT_EXPORT_TO = "2026-11-19";

/** Supported export formats offered by the dashboard controls. */
export const exportFormats: readonly ExportFormat[] = ["json", "csv"];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Returns true when `value` is a valid calendar date in `YYYY-MM-DD` format. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * Validates an inclusive `YYYY-MM-DD` range for metric exports.
 * Returns an inline error message when invalid, or `null` when valid.
 */
export function validateDateRange(fromDate: string, toDate: string): string | null {
  if (!fromDate || !toDate) {
    return "Select both a start date and an end date.";
  }
  if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) {
    return "Enter valid dates in YYYY-MM-DD format.";
  }
  if (fromDate > toDate) {
    return "Start date must be on or before end date.";
  }
  return null;
}

/**
 * Converts inclusive `YYYY-MM-DD` calendar dates into UTC ISO 8601 bounds
 * suitable for `ObservabilityHub.export` and `ObservabilityHub.summarize`.
 */
export function buildMetricsQuery(fromDate: string, toDate: string): MetricsQuery {
  return {
    from: `${fromDate}T00:00:00.000Z`,
    to: `${toDate}T23:59:59.999Z`,
  };
}

/** Formats the download filename for a date range and export format. */
export function buildExportFilename(
  fromDate: string,
  toDate: string,
  format: ExportFormat,
): string {
  return `tollway-metrics-${fromDate}-${toDate}.${format}`;
}

/**
 * The single seam between the exports view and `@vegaforge/tollway-observability`.
 *
 * Returns a fresh `ObservabilityHub` seeded with deterministic stub metrics so
 * `export()` and `summarize()` run real filtering and serialization without
 * waiting on a live service endpoint.
 */
export async function fetchMetricsExport(): Promise<MetricsExportSnapshot> {
  const hub = createObservabilityHub();
  for (const metric of STUB_METRICS) {
    hub.record(metric);
  }
  return {
    hub,
    defaultFrom: DEFAULT_EXPORT_FROM,
    defaultTo: DEFAULT_EXPORT_TO,
  };
}

const USDC_ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const STUB_METRICS: readonly PaymentMetric[] = [
  {
    payer: "GAGENTRESEARCH1",
    payee: "GSERVICEALPHA",
    model: "x402",
    amount: "120000000",
    asset: USDC_ASSET,
    latencyMs: 145,
    outcome: "settled",
    at: "2026-11-13T09:15:00.000Z",
  },
  {
    payer: "GAGENTSUMMARIZER",
    payee: "GSERVICEBETA",
    model: "mpp-charge",
    amount: "45000000",
    asset: USDC_ASSET,
    latencyMs: 98,
    outcome: "settled",
    at: "2026-11-14T14:22:10.000Z",
  },
  {
    payer: "GAGENTCLASSIFIER",
    payee: "GSERVICEGAMMA",
    model: "x402",
    amount: "21500000",
    asset: USDC_ASSET,
    latencyMs: 210,
    outcome: "failed",
    at: "2026-11-15T11:05:30.000Z",
  },
  {
    payer: "GAGENTRESEARCH2",
    payee: "GSERVICEBETA",
    model: "mpp-channel",
    amount: "300000000",
    asset: "native",
    latencyMs: 18,
    outcome: "settled",
    at: "2026-11-17T16:40:00.000Z",
  },
  {
    payer: "GAGENTROUTER",
    payee: "GSERVICEDELTA",
    model: "mpp-channel",
    amount: "98000000",
    asset: "native",
    latencyMs: 24,
    outcome: "skipped",
    at: "2026-11-18T08:12:00.000Z",
  },
  {
    payer: "GAGENTRESEARCH1",
    payee: "GSERVICEALPHA",
    model: "x402",
    amount: "1500000000",
    asset: USDC_ASSET,
    latencyMs: 162,
    outcome: "settled",
    at: "2026-11-18T17:30:45.000Z",
  },
  {
    payer: "GAGENTSUMMARIZER",
    payee: "GSERVICEALPHA",
    model: "mpp-charge",
    amount: "734200000",
    asset: USDC_ASSET,
    latencyMs: 112,
    outcome: "settled",
    at: "2026-11-19T10:15:00.000Z",
  },
  {
    payer: "GAGENTRESEARCH1",
    payee: "GSERVICEGAMMA",
    model: "mpp-channel",
    amount: "250000000",
    asset: USDC_ASSET,
    latencyMs: 21,
    outcome: "settled",
    at: "2026-11-19T15:45:00.000Z",
  },
];
