/**
 * The HTTP exchange a settler can finish instead of starting its own (#201).
 *
 * `createPaidFetch` has already sent the agent's request and received the 402.
 * A settler handed that exchange answers the challenge it was given and
 * replays the same request with the payment header, so a paid call makes
 * exactly two HTTP requests and a POST body is sent identically both times.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";

/** Request fields other than the method, headers and body, carried to the replay unchanged. */
export type ReplayOptions = Omit<RequestInit, "method" | "headers" | "body">;

/**
 * A request that can be sent more than once: the body is held as bytes, never
 * as a stream.
 */
export type ReplayableRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly options?: ReplayOptions;
};

/** The request the agent sent and the 402 it got back. */
export type HttpExchange = {
  readonly request: ReplayableRequest;
  readonly challenge: Response;
};

/** What a settler returns when it finished an exchange: the receipt and the paid response. */
export type PaidExchange = {
  receipt: SignedReceipt;
  response: Response;
};

/**
 * The init for sending `request` once more, with `extra` headers set on top
 * of the agent's own. A fresh `Headers` each time, so one send cannot change
 * the next.
 */
export function replayInit(
  request: ReplayableRequest,
  extra?: Record<string, string>,
): RequestInit {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return {
    ...request.options,
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}
