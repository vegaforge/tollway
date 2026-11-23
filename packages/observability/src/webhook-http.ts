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
  if (input.subscription.secret !== undefined) {
    // An empty secret would make every receiver accept an HMAC anyone can
    // compute. The hub refuses one at registration; this catches a
    // dispatcher built directly.
    assertWebhookSecret(input.subscription.secret);
    headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhookPayload({
      secret: input.subscription.secret,
      payload: body,
    });
  }
  return { body, headers };
}

/** Throws when a subscription secret is set but empty. */
export function assertWebhookSecret(secret: string | undefined): void {
  if (secret !== undefined && secret.length === 0) {
    throw new TypeError("a webhook secret must not be empty; omit it to send unsigned");
  }
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
  /**
   * Aborts the request from outside, for example when a dispatcher stops.
   * The call rejects as soon as it fires, even with a `fetch` that ignores
   * its signal.
   */
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) {
    throw new Error(`webhook ${input.url} was aborted before it was sent`);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, input.timeoutMs)
      : null;
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });

  // Settles when the request is aborted, so neither the timeout nor a
  // dispatcher stop depends on the fetch implementation honouring its signal.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          timedOut
            ? new Error(`webhook ${input.url} timed out after ${input.timeoutMs}ms`)
            : new Error(`webhook ${input.url} was aborted`),
        );
      },
      { once: true },
    );
  });
  // `aborted` only rejects while the race below is still waiting on it: once
  // the request settles, the timer is cleared and the outside signal is
  // detached, so nothing can abort the controller and leave an unhandled
  // rejection.

  let response: Response;
  try {
    response = await Promise.race([
      input.fetcher(input.url, {
        method: "POST",
        headers: input.request.headers,
        body: input.request.body,
        signal: controller.signal,
      }),
      aborted,
    ]);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw timedOut
        ? new Error(`webhook ${input.url} timed out after ${input.timeoutMs}ms`)
        : new Error(`webhook ${input.url} was aborted`);
    }
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", forwardAbort);
  }

  if (!response.ok) {
    throw new Error(
      `webhook ${input.url} responded with ${response.status} ${response.statusText}`.trim(),
    );
  }
}
