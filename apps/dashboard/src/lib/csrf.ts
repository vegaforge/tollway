import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "./session";

/**
 * CSRF defence for route handlers: the request must come from the
 * dashboard's own origin, and carry a token bound to the session in the
 * `x-csrf-token` header. A cross-site form cannot set that header, and a
 * cross-site script cannot read the token. Server actions get Next.js's
 * built-in origin check on top of the session check in authorize.ts.
 */

export const CSRF_HEADER = "x-csrf-token";

// The session secret also signs tokens. The prefix keeps a CSRF token from
// ever being a valid MAC for anything else signed with the same key.
const PURPOSE = "tollway-dashboard-csrf:";

export function csrfToken(sid: string): string {
  return createHmac("sha256", getSessionSecret())
    .update(PURPOSE + sid)
    .digest("hex");
}

export function isValidCsrf(sid: string, token: string): boolean {
  const actual = Buffer.from(token);
  const expected = Buffer.from(csrfToken(sid));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * True when the `Origin` header names this deployment. With
 * `DASHBOARD_ORIGIN` set (recommended behind a reverse proxy) the origin
 * must equal it exactly; otherwise its host must equal the request host, the
 * same rule Next.js applies to server actions. A request without `Origin`
 * is refused: every browser sends it on a cross-origin or non-GET fetch.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // An Origin that is not a URL cannot be ours, so the request is refused.
    return false;
  }

  const configured = process.env.DASHBOARD_ORIGIN;
  if (configured) {
    return parsed.origin === new URL(configured).origin;
  }

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return host !== null && parsed.host === host;
}
