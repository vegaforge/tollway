/**
 * Zod schemas for the typed SSE events streamed by GET /v1/events/stream.
 *
 * Every event carries:
 *   - `id`      – monotonically increasing string integer, used for resume.
 *   - `event`   – the event type (the `event:` SSE field).
 *   - `data`    – JSON payload, validated here before it touches state.
 *
 * The `metrics.delta` event is not in the WebhookEvent set because it is
 * stream-only: it coalesces running totals rather than sending individual
 * payment metrics.
 *
 * Keep these schemas in sync with docs/dashboard-data-contracts.md,
 * "Stream event types".
 */

import { receiptBodySchema } from "@vegaforge/tollway-core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Positive integer string; used as the SSE `id` field. */
export const eventIdSchema = z.string().regex(/^[1-9]\d*$/);

export const sseEventTypes = [
  "receipt.created",
  "channel.opened",
  "channel.closed",
  "budget.warning",
  "anomaly.detected",
  "metrics.delta",
  "reset",
] as const;

export type SseEventType = (typeof sseEventTypes)[number];

/** The filterable subset; `reset` is control-only and never filtered out. */
export const filterableEventTypes = sseEventTypes.filter(
  (t): t is Exclude<SseEventType, "reset"> => t !== "reset",
);

// ---------------------------------------------------------------------------
// Per-event data schemas
// ---------------------------------------------------------------------------

export const receiptCreatedDataSchema = z.object({
  receipt: receiptBodySchema,
  signature: z.object({
    keyId: z.string().min(1),
    algorithm: z.string().min(1),
    value: z.string().min(1),
  }),
});
export type ReceiptCreatedData = z.infer<typeof receiptCreatedDataSchema>;

export const channelOpenedDataSchema = z.object({
  channelId: z.string().min(1),
  counterparty: z.string().min(1),
  deposit: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  openedAt: z.iso.datetime(),
});
export type ChannelOpenedData = z.infer<typeof channelOpenedDataSchema>;

export const channelClosedDataSchema = z.object({
  channelId: z.string().min(1),
  counterparty: z.string().min(1),
  settled: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  closedAt: z.iso.datetime(),
});
export type ChannelClosedData = z.infer<typeof channelClosedDataSchema>;

export const budgetWarningDataSchema = z.object({
  agentId: z.string().min(1),
  rule: z.string().min(1),
  usedAmount: z.string().regex(/^\d+$/),
  limitAmount: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  at: z.iso.datetime(),
});
export type BudgetWarningData = z.infer<typeof budgetWarningDataSchema>;

export const anomalyDetectedDataSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  agentId: z.string().min(1),
  detail: z.string(),
  at: z.iso.datetime(),
});
export type AnomalyDetectedData = z.infer<typeof anomalyDetectedDataSchema>;

export const metricsDeltaDataSchema = z.object({
  settledCount: z.number().int().nonnegative(),
  openChannels: z.number().int().nonnegative(),
  anomalyCount: z.number().int().nonnegative(),
  spendByAsset: z.record(z.string(), z.string().regex(/^\d+$/)),
  at: z.iso.datetime(),
});
export type MetricsDeltaData = z.infer<typeof metricsDeltaDataSchema>;

export const resetDataSchema = z.object({
  reason: z.enum(["buffer-expired", "filter-changed"]),
});
export type ResetData = z.infer<typeof resetDataSchema>;

// ---------------------------------------------------------------------------
// Tagged union
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: "receipt.created"; id: string; data: ReceiptCreatedData }
  | { type: "channel.opened"; id: string; data: ChannelOpenedData }
  | { type: "channel.closed"; id: string; data: ChannelClosedData }
  | { type: "budget.warning"; id: string; data: BudgetWarningData }
  | { type: "anomaly.detected"; id: string; data: AnomalyDetectedData }
  | { type: "metrics.delta"; id: string; data: MetricsDeltaData }
  | { type: "reset"; id: string; data: ResetData };
