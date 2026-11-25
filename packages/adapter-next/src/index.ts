/**
 * @vegaforge/tollway-adapter-next
 *
 * Next.js App Router adapter for the Tollway payment gate. App Router route
 * handlers are plain Web fetch handlers, so this adapter speaks the standard
 * Request and Response and works with any Next.js version that exposes them
 * (which is every App Router release). The shape mirrors
 * @vegaforge/tollway-adapter-express and @vegaforge/tollway-adapter-hono, the worked references:
 * a thin map from a Web request into the framework-agnostic gate and gate
 * outcomes back out. See docs/design.md, "Repository layout".
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";
import {
  type AuthorizedPayment,
  type AuthorizeOutcome,
  type Gate,
  type PaywallOptions,
  type RouteTable,
  readBodyWithin,
  renderGateRejection,
  responseTooLarge,
  type SettleOutcome,
  settlementTiming,
  type TollwayRequest,
  twoPhaseAuthorizer,
} from "@vegaforge/tollway-server";

/** Extra argument a paid handler receives: the verified receipt. */
export type PaidContext = { receipt: SignedReceipt };

/** The one body every adapter returns when the gate itself throws (#107). */
const GATE_ERROR_BODY = { error: "payment backend unavailable" } as const;

/** A route handler that only runs after payment has settled. */
export type PaidHandler = (request: Request, context: PaidContext) => Response | Promise<Response>;

/**
 * A route handler for `settlement: "after-handler"`. It runs before the
 * payment settles, so there is no receipt yet, except for a replay of a
 * payment that already settled.
 */
export type AfterHandlerPaidHandler = (
  request: Request,
  context: { receipt?: SignedReceipt },
) => Response | Promise<Response>;

/**
 * Wraps a gate around an App Router route handler. The wrapped handler runs
 * only on a settled payment, receives the verified receipt via the second
 * argument, and has the PAYMENT-RESPONSE and TOLLWAY-RECEIPT headers added to its response.
 * Otherwise the wrapper answers the request itself (402 with the challenge,
 * or the rejection status with `{ error: { code, message } }`).
 *
 * Usage:
 *
 * ```ts
 * // app/quotes/latest/route.ts
 * import { withPaywall } from "@vegaforge/tollway-adapter-next";
 *
 * export const GET = withPaywall(gate, async (_request, { receipt }) => {
 *   return Response.json({ quote: 42, receiptId: receipt.receipt.id });
 * });
 * ```
 *
 * With `{ settlement: "after-handler" }` the payment is verified and locked,
 * the handler runs, and its response is read (up to the gate's limit) before
 * the payment settles. A handler that throws, or answers with a status the
 * gate treats as failure (any 5xx by default), is never charged: a throw is
 * rethrown, a failure response is returned as it is. If settlement fails,
 * the client gets the rejection instead of the handler's response.
 */
export function withPaywall(
  gate: Gate,
  handler: PaidHandler,
  options?: PaywallOptions & { settlement?: "before-handler" },
): (request: Request) => Promise<Response>;
/**
 * The form for `{ settlement: "after-handler" }`, or for a handler that works
 * with or without a receipt. See the first overload for the behaviour.
 */
export function withPaywall(
  gate: Gate,
  handler: AfterHandlerPaidHandler,
  options?: PaywallOptions,
): (request: Request) => Promise<Response>;
export function withPaywall(
  gate: Gate,
  handler: PaidHandler | AfterHandlerPaidHandler,
  options?: PaywallOptions,
): (request: Request) => Promise<Response> {
  const authorize = twoPhaseAuthorizer(gate, options);
  return async (request: Request): Promise<Response> => {
    const tollwayRequest: TollwayRequest = {
      method: request.method,
      url: requestUrl(request),
      headers: requestHeaders(request),
    };
    let outcome: AuthorizeOutcome;
    try {
      outcome = authorize ? await authorize(tollwayRequest) : await gate(tollwayRequest);
    } catch {
      return jsonResponse(GATE_ERROR_BODY, 502);
    }

    if (outcome.kind === "authorized") {
      // The overloads only accept "after-handler" with a handler whose
      // receipt is optional, so it can run before there is one.
      const afterHandler = handler as AfterHandlerPaidHandler;
      return settleAfterHandler(outcome, () => afterHandler(request, {}));
    }

    if (outcome.kind === "settled") {
      const response = await handler(request, { receipt: outcome.receipt });
      return withMergedHeaders(response, outcome.headers);
    }

    if (outcome.kind === "payment-required") {
      return jsonResponse(outcome.challenge, outcome.status, outcome.headers);
    }

    // The body and headers come from the server's one renderer, so every
    // adapter answers each error code the same way (#161).
    const rejection = renderGateRejection(outcome);
    return jsonResponse(rejection.body, rejection.status, rejection.headers);
  };
}

/** Applies the matching paid gate, while allowing free requests through the same handler. */
export function withRouteTable(
  table: RouteTable,
  handler: (request: Request, context: { receipt?: SignedReceipt }) => Response | Promise<Response>,
  options?: PaywallOptions,
): (request: Request) => Promise<Response> {
  // Checked once here, so a bad option fails at startup, not per request.
  settlementTiming(options);
  return async (request) => {
    const url = requestUrl(request);
    const match = table.match(request.method, url);
    if (match) return withPaywall(match.gate, handler, options)(request);
    return handler(request, {});
  };
}

/**
 * Runs the handler, then settles or abandons the authorized payment. A
 * handler error, thrown or from its body stream, abandons the payment and is
 * rethrown. A gate failure while settling is answered like any gate failure
 * (#107): 502 with the fixed body.
 */
async function settleAfterHandler(
  payment: AuthorizedPayment,
  run: () => Response | Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    await payment.abandon("handler-threw");
    throw error;
  }

  let body: Awaited<ReturnType<typeof readBodyWithin>>;
  try {
    body = await readBodyWithin(response.body, payment.maxResponseBytes);
  } catch (error) {
    await payment.abandon("handler-threw");
    throw error;
  }
  if (!body.ok) {
    await payment.abandon("response-too-large");
    const rejection = renderGateRejection(responseTooLarge(payment.maxResponseBytes));
    return jsonResponse(rejection.body, rejection.status, rejection.headers);
  }
  if (payment.isFailure(response.status)) {
    await payment.abandon("handler-failed");
    return rebuild(response, body.bytes, {});
  }
  let settled: SettleOutcome;
  try {
    settled = await payment.settle();
  } catch {
    return jsonResponse(GATE_ERROR_BODY, 502);
  }
  if (settled.kind === "settled") {
    return rebuild(response, body.bytes, settled.headers);
  }
  const rejection = renderGateRejection(settled);
  return jsonResponse(rejection.body, rejection.status, rejection.headers);
}

function rebuild(
  response: Response,
  body: Uint8Array<ArrayBuffer>,
  extraHeaders: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(body.byteLength === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function requestHeaders(request: Request): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function withMergedHeaders(response: Response, extraHeaders: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
