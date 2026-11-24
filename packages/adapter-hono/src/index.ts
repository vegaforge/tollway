/**
 * @vegaforge/tollway-adapter-hono
 *
 * A thin translation between Hono and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Hono requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import {
  type AuthorizedPayment,
  type Gate,
  type GateOutcome,
  type PaywallOptions,
  type RouteTable,
  readBodyWithin,
  responseTooLarge,
  settlementTiming,
  type TollwayRequest,
  twoPhaseAuthorizer,
} from "@vegaforge/tollway-server";
import type { Context, MiddlewareHandler } from "hono";

/** Where the verified receipt is stashed on the Hono context for downstream handlers. */
export const RECEIPT_CONTEXT_KEY = "tollwayReceipt";

type SettledReceipt = Extract<GateOutcome, { kind: "settled" }>["receipt"];

declare module "hono" {
  interface ContextVariableMap {
    tollwayReceipt: SettledReceipt;
  }
}

type JsonStatus = Parameters<Context["json"]>[1];

/**
 * Wraps a gate as Hono middleware. On a settled payment it sets the
 * PAYMENT-RESPONSE and TOLLWAY-RECEIPT headers, attaches the receipt to the Hono context, and
 * calls next() so the route handler can serve the resource. Otherwise it
 * answers the request itself (402 with the challenge, or the rejection
 * status).
 *
 * With `{ settlement: "after-handler" }` the payment is verified and locked,
 * the route runs, and its response is read (up to the gate's limit) before
 * the payment settles. A route that throws, or answers with a status the
 * gate treats as failure (any 5xx by default), is never charged. The route's
 * response then goes out with the payment headers; if settlement fails, the
 * client gets the rejection instead. No receipt exists while the route runs,
 * so the context carries none in this mode, except for a replay.
 */
export function honoPaywall(gate: Gate, options?: PaywallOptions): MiddlewareHandler {
  const authorize = twoPhaseAuthorizer(gate, options);
  return async (c, next) => {
    const request: TollwayRequest = {
      method: c.req.method,
      url: requestUrl(c),
      headers: requestHeaders(c),
    };
    const outcome = authorize ? await authorize(request) : await gate(request);

    if (outcome.kind === "authorized") {
      await settleAfterHandler(outcome, c, next);
      return;
    }
    return answer(outcome, c, next);
  };
}

async function answer(
  outcome: GateOutcome,
  c: Context,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  if (outcome.kind === "settled") {
    applyHeaders(c, outcome.headers);
    c.set(RECEIPT_CONTEXT_KEY, outcome.receipt);
    await next();
    return;
  }

  if (outcome.kind === "payment-required") {
    applyHeaders(c, outcome.headers);
    return c.json(outcome.challenge, outcome.status);
  }

  if (outcome.headers) applyHeaders(c, outcome.headers);
  return c.json({ error: outcome.reason }, outcome.status as JsonStatus);
}

/**
 * Runs the route, then settles or abandons. A thrown route error reaches
 * this middleware as `c.error` (Hono has already turned it into a response),
 * or as a rejection when the app has no error handler; either way the
 * payment is abandoned and the route's error goes out as it is.
 */
async function settleAfterHandler(
  payment: AuthorizedPayment,
  c: Context,
  next: () => Promise<void>,
): Promise<void> {
  try {
    await next();
  } catch (error) {
    await payment.abandon("handler-threw");
    throw error;
  }
  if (c.error) {
    await payment.abandon("handler-threw");
    return;
  }

  const response = c.res;
  const body = await readBodyWithin(response.body, payment.maxResponseBytes);
  if (!body.ok) {
    await payment.abandon("response-too-large");
    const rejection = responseTooLarge(payment.maxResponseBytes);
    replaceResponse(c, Response.json({ error: rejection.reason }, { status: rejection.status }));
    return;
  }
  if (payment.isFailure(response.status)) {
    await payment.abandon("handler-failed");
    replaceResponse(c, rebuild(response, body.bytes, {}));
    return;
  }
  const settled = await payment.settle();
  if (settled.kind === "settled") {
    replaceResponse(c, rebuild(response, body.bytes, settled.headers));
    return;
  }
  replaceResponse(
    c,
    Response.json(
      { error: settled.reason },
      { status: settled.status, headers: settled.headers ?? {} },
    ),
  );
}

/**
 * Sets the context's response to exactly this one. Hono's setter copies the
 * old response's headers onto a new one; clearing first stops a rejection
 * from carrying the discarded route's headers.
 */
function replaceResponse(c: Context, response: Response): void {
  c.res = undefined;
  c.res = response;
}

function rebuild(
  response: Response,
  body: Uint8Array<ArrayBuffer>,
  extra: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(body.byteLength === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function honoRouteTable(table: RouteTable, options?: PaywallOptions): MiddlewareHandler {
  // Checked once here, so a bad option fails at startup, not per request.
  settlementTiming(options);
  return async (c, next) => {
    const match = table.match(c.req.method, requestUrl(c));
    if (!match) {
      await next();
      return;
    }
    // Return the inner middleware's response: for an unpaid or rejected
    // request it is the 402 or error, and dropping it leaves Hono with none.
    return honoPaywall(match.gate, options)(c, next);
  };
}

function requestUrl(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

function requestHeaders(c: Context): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function applyHeaders(c: Context, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
  }
}
