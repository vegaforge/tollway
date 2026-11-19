import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CSRF_HEADER, isSameOrigin, isValidCsrf } from "./csrf";
import {
  COOKIE_NAME,
  ForbiddenError,
  hasRole,
  type Role,
  readSession,
  type Session,
  verifySessionToken,
} from "./session";
import { isActiveSession } from "./session-store";

/**
 * The authorisation check every route handler, server action, and server
 * component runs for itself. `proxy.ts` makes the same check first, but the
 * proxy is an optimistic filter: a matcher mistake or a future route that
 * slips past it must still be refused here. See the Next.js authentication
 * guide, "Optimistic checks with Proxy".
 */

export type Authorized = { ok: true; session: Session };
export type Denied = { ok: false; response: NextResponse };

function deny(status: 401 | 403, error: string): Denied {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/** A signed session that the server still holds as live. */
export async function activeSession(request: Request): Promise<Session | null> {
  const session = await readSession(request);
  return session !== null && isActiveSession(session) ? session : null;
}

/**
 * For route handlers. Reads need a live session with at least `role`.
 * Anything that changes state also passes `{ mutation: true }`, which adds
 * the same-origin and CSRF-token checks.
 */
export async function authorizeRequest(
  request: Request,
  role: Role,
  options: { mutation?: boolean } = {},
): Promise<Authorized | Denied> {
  const session = await activeSession(request);
  if (session === null) return deny(401, "Unauthorized");
  if (!hasRole(session.role, role)) return deny(403, "Forbidden");
  if (options.mutation) {
    const token = request.headers.get(CSRF_HEADER) ?? "";
    if (!isSameOrigin(request) || !isValidCsrf(session.sid, token)) {
      return deny(403, "Forbidden");
    }
  }
  return { ok: true, session };
}

/** For server components: the live session from the request cookies, or null. */
export async function currentSession(): Promise<Session | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value) return null;
  const session = await verifySessionToken(value);
  return session !== null && isActiveSession(session) ? session : null;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: sign in first");
    this.name = "UnauthorizedError";
  }
}

/**
 * For server actions, which Next.js already restricts to same-origin
 * requests. Throws so the action stops before it calls anything; a viewer
 * cannot reach an admin call by crafting the action request by hand.
 */
export async function requireSession(role: Role): Promise<Session> {
  const session = await currentSession();
  if (session === null) throw new UnauthorizedError();
  if (!hasRole(session.role, role)) throw new ForbiddenError(role);
  return session;
}
