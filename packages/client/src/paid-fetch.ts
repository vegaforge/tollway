/**
 * `createPaidFetch`: a function with the `fetch` signature that pays for a
 * 402 (#201). It is the agent-facing entry point docs/design.md describes as
 * "one call to pay for a resource". See "Architecture" (agent side) and "The
 * model router".
 *
 * One paid call is exactly two HTTP requests:
 *
 * 1. The agent's request, sent once. Anything but a 402 is returned untouched.
 * 2. On a 402, the challenge becomes a `PaymentOffer` (`challenge.ts`) and
 *    goes through `client.pay()`, so offer checks, quarantine, policy,
 *    routing, receipt verification, receipt binding, the receipt store and
 *    events all run exactly as they do for any payment. The settler for the
 *    routed model answers this 402 and replays the agent's request with the
 *    payment header (`ClientSettler.settleExchange`).
 *
 * The body is buffered before the first send so the replay carries the same
 * bytes. A body passed as a `ReadableStream` cannot be replayed: it is sent
 * as is, and if the answer is a 402 the call rejects before any payment.
 *
 * Global `fetch` is never patched; the injected `fetch` is the transport. The
 * settlers make the paid request with their own `fetch` option, so give both
 * the same one.
 */

import {
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
} from "@vegaforge/tollway-core";
import { offerFromChallenge } from "./challenge.js";
import { type ReplayableRequest, type ReplayOptions, replayInit } from "./exchange.js";
import type { TollwayClient } from "./index.js";

/** What `fetch` accepts as its first argument. */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

/** The response, plus the verified receipt and the model that paid when a 402 was paid. */
export type PaidResponse = Response & {
  receipt?: SignedReceipt;
  model?: SettlementModel;
};

/** The function `createPaidFetch` returns. */
export type PaidFetch = (input: FetchInput, init?: RequestInit) => Promise<PaidResponse>;

export type PaidFetchOptions = {
  /**
   * The client that pays. Create it with `settlers` (one per model the agent
   * can pay) whose settlers implement `settleExchange`, as the x402 and MPP
   * charge settlers do.
   */
  client: TollwayClient;
  /** The network the agent pays on; picks the matching option from the 402. */
  network: StellarNetwork;
  /** The transport for the agent's request. Defaults to `globalThis.fetch`; never patched. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Creates a drop-in `fetch` that pays x402 and MPP 402 challenges through
 * `client.pay()`. A non-402 response passes through untouched. A paid
 * response is the service's own `Response` with `receipt` and `model` added.
 */
export function createPaidFetch(options: PaidFetchOptions): PaidFetch {
  const { client, network } = options;
  const doFetch = options.fetch ?? globalThis.fetch;

  return async (input, init) => {
    if (init?.body instanceof ReadableStream) {
      // Sent once as is. It cannot be sent a second time, so a 402 ends here.
      const response = await doFetch(input, init);
      if (response.status === 402) {
        throw new TollwayError(
          "payment-failed",
          "the request body is a stream, which cannot be replayed with a payment; pass the body as bytes or a string to pay for this request",
        );
      }
      return response;
    }

    const request = await toReplayable(input, init);
    const first = await doFetch(request.url, replayInit(request));
    if (first.status !== 402) return first;

    const offer = offerFromChallenge(first, request.url, network);
    const result = await client.pay({
      resource: request.url,
      offer,
      exchange: { request, challenge: first },
    });
    if (!result.response) {
      // pay() returns a response for every exchange; this guards the type.
      throw new TollwayError(
        "payment-failed",
        `the payment for ${request.url} settled without a paid response`,
      );
    }
    return Object.assign(result.response, { receipt: result.receipt, model: result.model });
  };
}

/**
 * Normalises any `fetch` input into a request that can be sent twice. The
 * `Request` constructor applies fetch's own rules (a GET with a body is a
 * TypeError) and sets the content type for form and blob bodies.
 */
async function toReplayable(
  input: FetchInput,
  init: RequestInit | undefined,
): Promise<ReplayableRequest> {
  const normalised = new Request(input, init);
  const body =
    normalised.body === null ? undefined : new Uint8Array(await normalised.arrayBuffer());
  const { method: _method, headers: _headers, body: _body, ...rest } = init ?? {};
  const options: ReplayOptions = {
    ...rest,
    // A Request input carries its own abort signal; keep it unless init replaces it.
    ...(rest.signal === undefined && input instanceof Request ? { signal: input.signal } : {}),
  };
  return {
    url: normalised.url,
    method: normalised.method,
    headers: new Headers(normalised.headers),
    ...(body === undefined ? {} : { body }),
    options,
  };
}
