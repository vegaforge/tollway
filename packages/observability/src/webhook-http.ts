/**
 * The HTTP side of a webhook delivery: headers (including a fresh signature),
 * the POST, the per-attempt timeout, and the failure messages the outbox
 * stores.
 *
 * Errors here name the URL and the status but never the request headers,
 * because subscription headers can carry auth tokens and row errors are
 * persisted. See docs/webhook-delivery.md.
 */

import {
  type TollwayEvent,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
} from "./events.js";
import type { WebhookSubscription } from "./index.js";
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "./webhook-signature.js";

export type WebhookRequest = {
  /** The exact bytes to POST. The signature covers these bytes. */
  body: string;
  headers: Record<string, string>;
};

/**
 * Builds the request for one attempt. Call it per attempt, not once per
 * delivery: a retry needs a fresh signature timestamp. `deliveryId` is set for
 * outbox deliveries and omitted for inline ones.
 */
export async function buildWebhookRequest(input: {
  subscription: WebhookSubscription;
  event: TollwayEvent;
  deliveryId?: string;
}): Promise<WebhookRequest> {
  const body = JSON.stringify(input.event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(input.subscription.headers ?? {}),
    [WEBHOOK_EVENT_ID_HEADER]: input.event.id,
  };
  if (input.deliveryId) {
    headers[WEBHOOK_DELIVERY_ID_HEADER] = input.deliveryId;
  }
  if (input.subscription.secret) {
    headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhookPayload({
      secret: input.subscription.secret,
      payload: body,
    });
  }
  return { body, headers };
}

/**
 * POSTs one request. Resolves on a 2xx response and throws otherwise. A
 * stalled socket is aborted after `timeoutMs`; `0` disables the timeout.
 */
export async function postWebhook(input: {
  fetcher: typeof globalThis.fetch;
  url: string;
  request: WebhookRequest;
  timeoutMs: number;
}): Promise<void> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller && input.timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, input.timeoutMs)
      : null;

  let response: Response;
  try {
    response = await input.fetcher(input.url, {
      method: "POST",
      headers: input.request.headers,
      body: input.request.body,
      signal: controller?.signal,
    });
  } catch (cause) {
    if (controller?.signal.aborted) {
      throw new Error(`webhook ${input.url} timed out after ${input.timeoutMs}ms`);
    }
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `webhook ${input.url} responded with ${response.status} ${response.statusText}`.trim(),
    );
  }
}
