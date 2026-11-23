/**
 * Zod schemas for the typed SSE events coming from @vegaforge/tollway-service.
 *
 * These match the schemas in apps/tollway-service/src/event-schemas.ts.
 * They are duplicated here (rather than imported from the service) so the
 * dashboard remains independent of the service's build artefacts, and so
 * the proxy route and the useEventStream hook both have a single import
 * path that works in the Next.js server environment.
 *
 * Keep these schemas in sync with:
 *   - apps/tollway-service/src/event-schemas.ts
 *   - docs/dashboard-data-contracts.md, "Stream event types"
 */

import { receiptBodySchema } from "@vegaforge/tollway-core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

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
// Tagged union for client-side dispatch
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: "receipt.created"; id: string; data: ReceiptCreatedData }
  | { type: "channel.opened"; id: string; data: ChannelOpenedData }
  | { type: "channel.closed"; id: string; data: ChannelClosedData }
  | { type: "budget.warning"; id: string; data: BudgetWarningData }
  | { type: "anomaly.detected"; id: string; data: AnomalyDetectedData }
  | { type: "metrics.delta"; id: string; data: MetricsDeltaData }
  | { type: "reset"; id: string; data: ResetData };

/**
 * Parse and validate a raw SSE message into a typed `SseEvent`.
 * Returns `null` when the payload is structurally valid JSON but fails
 * schema validation, letting the caller silently discard the event.
 * Throws for unparseable JSON.
 */
export function parseSseEvent(eventType: string, rawData: string, id: string): SseEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (err) {
    throw new Error(
      `SSE event ${eventType}: JSON parse error – ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  switch (eventType) {
    case "receipt.created": {
      const result = receiptCreatedDataSchema.safeParse(parsed);
      return result.success ? { type: "receipt.created", id, data: result.data } : null;
    }
    case "channel.opened": {
      const result = channelOpenedDataSchema.safeParse(parsed);
      return result.success ? { type: "channel.opened", id, data: result.data } : null;
    }
    case "channel.closed": {
      const result = channelClosedDataSchema.safeParse(parsed);
      return result.success ? { type: "channel.closed", id, data: result.data } : null;
    }
    case "budget.warning": {
      const result = budgetWarningDataSchema.safeParse(parsed);
      return result.success ? { type: "budget.warning", id, data: result.data } : null;
    }
    case "anomaly.detected": {
      const result = anomalyDetectedDataSchema.safeParse(parsed);
      return result.success ? { type: "anomaly.detected", id, data: result.data } : null;
    }
    case "metrics.delta": {
      const result = metricsDeltaDataSchema.safeParse(parsed);
      return result.success ? { type: "metrics.delta", id, data: result.data } : null;
    }
    case "reset": {
      const result = resetDataSchema.safeParse(parsed);
      return result.success ? { type: "reset", id, data: result.data } : null;
    }
    default:
      return null;
  }
}
