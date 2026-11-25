import type { MetricsQuery, PaymentMetric } from "./metrics.js";
import {
  assertValidMetric,
  closedStoreError,
  copyMetric,
  decodeCursor,
  encodeCursor,
  type MetricsStore,
  metricMatches,
  metricTime,
  queryBounds,
  resolvePageLimit,
} from "./metrics-store.js";
import { SummaryAccumulator } from "./summary.js";

type Row = { position: number; time: number; metric: PaymentMetric };

/**
 * A {@link MetricsStore} held in memory. Nothing survives a restart; use it
 * for tests and single-process deployments that do not need history. It
 * applies the same validation as the durable stores, so code tested against
 * it behaves the same against SQLite or Postgres.
 */
export function createMemoryMetricsStore(): MetricsStore {
  const rows: Row[] = [];
  let closed = false;

  function open(): void {
    if (closed) throw closedStoreError();
  }

  function* matching(query: MetricsQuery | undefined, after: number): Generator<Row> {
    const bounds = queryBounds(query);
    for (const row of rows) {
      if (row.position <= after) continue;
      if (metricMatches(row.metric, row.time, query, bounds)) yield row;
    }
  }

  return {
    async append(metrics) {
      open();
      // Validate the whole batch before keeping any of it.
      for (const metric of metrics) assertValidMetric(metric);
      for (const metric of metrics) {
        rows.push({
          position: rows.length + 1,
          time: metricTime(metric),
          metric: copyMetric(metric),
        });
      }
    },
    async query(query, page) {
      open();
      const limit = resolvePageLimit(page);
      const after = decodeCursor(page?.cursor);
      const found: Row[] = [];
      for (const row of matching(query, after)) {
        if (found.length === limit) {
          const last = found[found.length - 1] as Row;
          return {
            metrics: found.map((r) => copyMetric(r.metric)),
            nextCursor: encodeCursor(last.position),
          };
        }
        found.push(row);
      }
      return { metrics: found.map((r) => copyMetric(r.metric)) };
    },
    async summarize(query) {
      open();
      const summary = new SummaryAccumulator();
      for (const row of matching(query, 0)) summary.add(row.metric);
      return summary.result();
    },
    async close() {
      closed = true;
    },
  };
}
