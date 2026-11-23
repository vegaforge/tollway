/**
 * The storage seam the metrics routes read and write. The service never rolls
 * metrics up itself: `summarize`, `timeseries` and `export` are the
 * `@vegaforge/tollway-observability` primitives, so the API and an in-process
 * hub cannot disagree. A persistent store (issue #217) implements this
 * interface without changing the routes.
 */

import {
  createObservabilityHub,
  type ExportFormat,
  type MetricsQuery,
  type PaymentMetric,
  type SpendSummary,
  type TimeseriesQuery,
  type TimeseriesResult,
} from "@vegaforge/tollway-observability";

export interface MetricsStore {
  record(metrics: readonly PaymentMetric[]): void | Promise<void>;
  summarize(query?: MetricsQuery): SpendSummary | Promise<SpendSummary>;
  timeseries(query: TimeseriesQuery): TimeseriesResult | Promise<TimeseriesResult>;
  export(format: ExportFormat, query?: MetricsQuery): string | Promise<string>;
}

/**
 * The default store: the observability hub's in-memory metrics array. It is
 * process-local, so a deployment that runs more than one service process
 * needs a shared store behind the same interface, and a restart starts empty.
 */
export function createInMemoryMetricsStore(): MetricsStore {
  const hub = createObservabilityHub();
  return {
    record(metrics) {
      for (const metric of metrics) {
        hub.record(metric);
      }
    },
    summarize(query) {
      return hub.summarize(query);
    },
    timeseries(query) {
      return hub.timeseries(query);
    },
    export(format, query) {
      return hub.export(format, query);
    },
  };
}
