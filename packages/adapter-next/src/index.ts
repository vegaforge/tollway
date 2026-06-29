/**
 * @tollway/adapter-next
 *
 * Next.js App Router adapter for the Tollway payment gate. App Router route
 * handlers are plain Web fetch handlers, so this adapter speaks the standard
 * Request and Response and works with any Next.js version that exposes them
 * (which is every App Router release). The shape mirrors
 * @tollway/adapter-express and @tollway/adapter-hono, the worked references:
 * a thin map from a Web request into the framework-agnostic gate and gate
 * outcomes back out. See docs/design.md, "Repository layout".
 */

import type { SignedReceipt } from "@tollway/core";
import type { Gate } from "@tollway/server";

/** Extra argument a paid handler receives: the verified receipt. */
export type PaidContext = { receipt: SignedReceipt };

/** A route handler that only runs after payment has settled. */
export type PaidHandler = (request: Request, context: PaidContext) => Response | Promise<Response>;

/**
 * Wraps a gate around an App Router route handler. The wrapped handler runs
 * only on a settled payment, receives the verified receipt via the second
 * argument, and has the PAYMENT-RESPONSE header added to its response.
 * Otherwise the wrapper answers the request itself (402 with the challenge,
 * or the rejection status with `{ error: reason }`).
 *
 * Usage:
 *
 * ```ts
 * // app/quotes/latest/route.ts
 * import { withPaywall } from "@tollway/adapter-next";
 *
 * export const GET = withPaywall(gate, async (_request, { receipt }) => {
 *   return Response.json({ quote: 42, receiptId: receipt.receipt.id });
 * });
 * ```
 */
export function withPaywall(
  gate: Gate,
  handler: PaidHandler,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const outcome = await gate({
      method: request.method,
      url: requestUrl(request),
      headers: requestHeaders(request),
    });

    if (outcome.kind === "settled") {
      const response = await handler(request, { receipt: outcome.receipt });
      return withMergedHeaders(response, outcome.headers);
    }

    if (outcome.kind === "payment-required") {
      return jsonResponse(outcome.challenge, outcome.status, outcome.headers);
    }

    return jsonResponse({ error: outcome.reason }, outcome.status);
  };
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
