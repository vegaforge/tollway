/**
 * Prometheus /metrics exporter with documented Tollway metric names.
 * Exposes payment metrics in Prometheus text format for scraping.
 */

import type { PaymentMetric, SpendSummary } from "./index.js";

/** Metric name and documentation pairs for Prometheus. */
export const TOLLWAY_METRIC_NAMES = {
  settlementCount: {
    name: "tollway_settlements_total",
    help: "Total number of settlements by model and outcome",
  },
  settlementAmount: {
    name: "tollway_settlement_amount_total",
    help: "Total settlement amount in smallest asset unit by asset and outcome",
  },
  settlementLatency: {
    name: "tollway_settlement_latency_ms",
    help: "Settlement latency in milliseconds (p50, p95, p99)",
  },
  activeChannels: {
    name: "tollway_active_channels",
    help: "Number of active payment channels by state",
  },
  budgetRemaining: {
    name: "tollway_budget_remaining",
    help: "Remaining budget by agent address and asset",
  },
  payerSpend: {
    name: "tollway_payer_spend_total",
    help: "Total spend by payer address and asset",
  },
  payeeSpend: {
    name: "tollway_payee_spend_total",
    help: "Total spend by payee address and asset",
  },
};

export interface PrometheusExporterOptions {
  /** Prefix for all metric names (optional). Defaults to no prefix. */
  prefix?: string;
}

/**
 * Formats payment metrics as Prometheus text exposition format (OpenMetrics).
 * Each line is TYPE, HELP, or a metric value.
 */
export function formatPrometheusMetrics(
  metrics: PaymentMetric[],
  options: PrometheusExporterOptions = {},
): string {
  const prefix = options.prefix ? `${options.prefix}_` : "";
  const lines: string[] = [];
  const timestamp = Date.now();

  // Helper to escape label values
  function escapeLabel(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  // Helper to add metric with labels
  function addMetric(
    name: string,
    value: number | string,
    labels: Record<string, string>,
    help?: string,
  ) {
    const fullName = `${prefix}${name}`;
    if (help && !lines.find((l) => l.startsWith(`# HELP ${fullName}`))) {
      lines.push(`# HELP ${fullName} ${help}`);
      lines.push(`# TYPE ${fullName} gauge`);
    }
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",");
    lines.push(`${fullName}{${labelStr}} ${value} ${timestamp}`);
  }

  // Aggregate metrics
  const byModel: Record<string, Record<string, number>> = {};
  const byAsset: Record<string, Record<string, number>> = {};
  const byOutcome: Record<string, number> = {};
  const latencies: number[] = [];
  const byPayer: Record<string, Record<string, bigint>> = {};
  const byPayee: Record<string, Record<string, bigint>> = {};

  for (const m of metrics) {
    if (!byModel[m.model]) byModel[m.model] = {};
    if (!byModel[m.model][m.outcome]) byModel[m.model][m.outcome] = 0;
    byModel[m.model][m.outcome]++;

    if (!byAsset[m.asset]) byAsset[m.asset] = {};
    if (!byAsset[m.asset][m.outcome]) byAsset[m.asset][m.outcome] = 0;
    byAsset[m.asset][m.outcome]++;

    byOutcome[m.outcome] = (byOutcome[m.outcome] ?? 0) + 1;
    latencies.push(m.latencyMs);

    if (!byPayer[m.payer]) byPayer[m.payer] = {};
    if (!byPayer[m.payer][m.asset]) byPayer[m.payer][m.asset] = 0n;
    try {
      byPayer[m.payer][m.asset] += BigInt(m.amount);
    } catch {
      // Skip invalid amounts
    }

    if (!byPayee[m.payee]) byPayee[m.payee] = {};
    if (!byPayee[m.payee][m.asset]) byPayee[m.payee][m.asset] = 0n;
    try {
      byPayee[m.payee][m.asset] += BigInt(m.amount);
    } catch {
      // Skip invalid amounts
    }
  }

  // Export settlement counts by model and outcome
  for (const [model, outcomes] of Object.entries(byModel)) {
    for (const [outcome, count] of Object.entries(outcomes)) {
      addMetric(
        TOLLWAY_METRIC_NAMES.settlementCount.name,
        count,
        { model, outcome },
        TOLLWAY_METRIC_NAMES.settlementCount.help,
      );
    }
  }

  // Export settlement amounts by asset and outcome
  for (const [asset, outcomes] of Object.entries(byAsset)) {
    for (const [outcome, count] of Object.entries(outcomes)) {
      addMetric(
        TOLLWAY_METRIC_NAMES.settlementAmount.name,
        count,
        { asset, outcome },
        TOLLWAY_METRIC_NAMES.settlementAmount.help,
      );
    }
  }

  // Export latency percentiles
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    addMetric(
      `${TOLLWAY_METRIC_NAMES.settlementLatency.name}_p50`,
      p50,
      {},
      `${TOLLWAY_METRIC_NAMES.settlementLatency.help} (p50)`,
    );
    addMetric(
      `${TOLLWAY_METRIC_NAMES.settlementLatency.name}_p95`,
      p95,
      {},
      `${TOLLWAY_METRIC_NAMES.settlementLatency.help} (p95)`,
    );
    addMetric(
      `${TOLLWAY_METRIC_NAMES.settlementLatency.name}_p99`,
      p99,
      {},
      `${TOLLWAY_METRIC_NAMES.settlementLatency.help} (p99)`,
    );
  }

  // Export payer spend
  for (const [payer, assets] of Object.entries(byPayer)) {
    for (const [asset, amount] of Object.entries(assets)) {
      addMetric(
        TOLLWAY_METRIC_NAMES.payerSpend.name,
        amount.toString(),
        { payer, asset },
        TOLLWAY_METRIC_NAMES.payerSpend.help,
      );
    }
  }

  // Export payee spend
  for (const [payee, assets] of Object.entries(byPayee)) {
    for (const [asset, amount] of Object.entries(assets)) {
      addMetric(
        TOLLWAY_METRIC_NAMES.payeeSpend.name,
        amount.toString(),
        { payee, asset },
        TOLLWAY_METRIC_NAMES.payeeSpend.help,
      );
    }
  }

  lines.push("# EOF\n");
  return lines.join("\n");
}

/**
 * Creates an HTTP handler for a Prometheus /metrics endpoint.
 * Returns a function that can be used as Express/Fastify middleware.
 */
export function createPrometheusHandler(
  metricsQuery: () => Promise<PaymentMetric[]>,
  options: PrometheusExporterOptions = {},
) {
  return async (req: any, res: any) => {
    try {
      const metrics = await metricsQuery();
      const output = formatPrometheusMetrics(metrics, options);
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(output);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "Internal error");
    }
  };
}
