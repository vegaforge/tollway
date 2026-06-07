/**
 * @tollway/observability
 *
 * Spend, latency, and failure metrics per agent, per service, and per model,
 * with machine-readable exports and webhooks for whatever you want to wire
 * up. See docs/design.md, "Observability".
 */

import { NotImplementedError, type SettlementModel } from "@tollway/core";

/** Webhook event names, matching docs/design.md, "Observability". */
export const webhookEvents = [
  "receipt.created",
  "channel.opened",
  "channel.closed",
  "budget.warning",
  "anomaly.detected",
] as const;

export type WebhookEvent = (typeof webhookEvents)[number];

export type TollwayEvent = {
  type: WebhookEvent;
  /** ISO 8601 timestamp. */
  at: string;
  /** Event-specific fields; shape depends on the event type. */
  data: Record<string, unknown>;
};

/** A single measured payment, the unit metrics roll up from. */
export type PaymentMetric = {
  payer: string;
  payee: string;
  model: SettlementModel;
  amount: string;
  asset: string;
  latencyMs: number;
  outcome: "settled" | "failed" | "skipped";
  at: string;
};

export type MetricsQuery = {
  payer?: string;
  payee?: string;
  model?: SettlementModel;
  /** Inclusive ISO 8601 bounds. */
  from?: string;
  to?: string;
};

export type SpendSummary = {
  totalAmount: string;
  count: number;
  byModel: Partial<Record<SettlementModel, string>>;
};

export type ExportFormat = "json" | "csv";

export type WebhookHandler = (event: TollwayEvent) => void | Promise<void>;

export interface ObservabilityHub {
  record(metric: PaymentMetric): void;
  emit(event: TollwayEvent): Promise<void>;
  on(event: WebhookEvent, handler: WebhookHandler): void;
  summarize(query?: MetricsQuery): SpendSummary;
  export(format: ExportFormat, query?: MetricsQuery): string;
}

/**
 * TODO(phase 4): implement metric collection, the spend rollups, exports,
 * and webhook dispatch behind this interface, then feed the dashboard from
 * it. See docs/design.md, "Observability".
 */
export function createObservabilityHub(): ObservabilityHub {
  throw new NotImplementedError("the observability hub", 'docs/design.md, "Observability"');
}
