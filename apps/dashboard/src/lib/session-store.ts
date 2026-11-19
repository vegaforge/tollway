import type { Session } from "./session";

/**
 * Server-side record of live sessions, so logout and admin revocation take
 * effect immediately instead of when the token expires.
 *
 * The store is in memory and lives on `globalThis`. Next.js bundles
 * `proxy.ts` separately from route handlers, so a module-level Map would be
 * two different Maps in one process and the proxy would never see a
 * revocation. A process restart drops every session, which signs everyone
 * out: the safe direction. One dashboard process is the supported
 * deployment; running several replicas needs a shared store, see
 * docs/dashboard-data-contracts.md, "Dashboard security".
 */

type StoredSession = { session: Session; revoked: boolean };

const STORE_KEY = Symbol.for("tollway.dashboard.sessions");

type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: Map<string, StoredSession> };

function store(): Map<string, StoredSession> {
  const scope = globalThis as GlobalWithStore;
  let sessions = scope[STORE_KEY];
  if (sessions === undefined) {
    sessions = new Map();
    scope[STORE_KEY] = sessions;
  }
  return sessions;
}

function isExpired(session: Session, now: number): boolean {
  return session.exp * 1000 <= now;
}

export function rememberSession(session: Session): void {
  const sessions = store();
  const now = Date.now();
  // Drop expired entries on every sign-in so the map is bounded by the
  // number of sessions alive at once, not by every sign-in ever made.
  for (const [sid, stored] of sessions) {
    if (isExpired(stored.session, now)) sessions.delete(sid);
  }
  sessions.set(session.sid, { session, revoked: false });
}

/**
 * True only for a session this process issued, that is not revoked or
 * expired, and whose token claims still match what was issued.
 */
export function isActiveSession(session: Session): boolean {
  const stored = store().get(session.sid);
  if (!stored || stored.revoked || isExpired(stored.session, Date.now())) {
    return false;
  }
  return (
    session.exp === stored.session.exp &&
    session.role === stored.session.role &&
    session.username === stored.session.username
  );
}

/** Revokes one session. Returns false when the id is unknown. */
export function revokeSession(sid: string): boolean {
  const stored = store().get(sid);
  if (!stored) return false;
  stored.revoked = true;
  return true;
}

export function resetSessionStore(): void {
  store().clear();
}
