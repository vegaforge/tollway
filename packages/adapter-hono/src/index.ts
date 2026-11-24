/**
 * @vegaforge/tollway-adapter-hono
 *
 * A thin translation between Hono and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Hono requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import {
  type Gate,
  type GateOutcome,
  type RouteTable,
  readBodyStream,
  renderGateRejection,
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
 */
export function honoPaywall(gate: Gate): MiddlewareHandler {
  return async (c, next) => {
    const outcome = await gate({
      method: c.req.method,
      url: requestUrl(c),
      headers: requestHeaders(c),
      // Read from a clone, only for a route with bindBody, so the handler
      // still reads the original body unchanged.
      body: { read: (maxBytes) => readBodyStream(c.req.raw.clone().body, maxBytes) },
    });

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

    // The body and headers come from the server's one renderer, so every
    // adapter answers each error code the same way (#161).
    const rejection = renderGateRejection(outcome);
    applyHeaders(c, rejection.headers);
    return c.json(rejection.body, rejection.status as JsonStatus);
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function honoRouteTable(table: RouteTable): MiddlewareHandler {
  return async (c, next) => {
    const match = table.match(c.req.method, requestUrl(c));
    if (!match) {
      await next();
      return;
    }
    // Return the inner middleware's response: for an unpaid or rejected
    // request it is the 402 or error, and dropping it leaves Hono with none.
    return honoPaywall(match.gate)(c, next);
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
