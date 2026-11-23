/**
 * The webhook event catalogue and the envelope every delivery carries.
 *
 * Split from `index.ts` so the outbox and dispatcher can import the runtime
 * catalogue without importing the hub module. See docs/design.md,
 * "Observability".
 */

/** Webhook event names, matching docs/design.md, "Observability". */
export const webhookEvents = [
  "receipt.created",
  "channel.opened",
  "channel.closed",
  "budget.warning",
  "anomaly.detected",
] as const;

export type WebhookEvent = (typeof webhookEvents)[number];

/**
 * Headers every outbox delivery carries. Receivers dedupe on the event id.
 * The delivery id names the delivery row: it is the same across retries of
 * one row and new on enqueue and replay, which helps match a request to a
 * row in delivery logs.
 */
export const WEBHOOK_EVENT_ID_HEADER = "Tollway-Event-Id";
export const WEBHOOK_DELIVERY_ID_HEADER = "Tollway-Delivery-Id";

export type TollwayEvent = {
  /**
   * Stable event id (UUID). Assigned once, at emit time, so a receiver can
   * dedupe retries and deliveries across restarts on it.
   */
  id: string;
  type: WebhookEvent;
  /** ISO 8601 timestamp. */
  at: string;
  /** Event-specific fields; shape depends on the event type. */
  data: Record<string, unknown>;
};

/**
 * What a caller hands to `emit`. The hub assigns an id when the input does
 * not carry one; passing an id is allowed so a caller that retries its own
 * emit keeps the same event id.
 */
export type TollwayEventInput = Omit<TollwayEvent, "id"> & { id?: string };

/** True when `value` is one of the documented event names. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && (webhookEvents as readonly string[]).includes(value);
}
