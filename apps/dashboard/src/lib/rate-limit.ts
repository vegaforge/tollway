/**
 * Login throttling. Only failed attempts count, so a user who signs in
 * correctly is never slowed down.
 *
 * Failures are counted per username, whatever the source, because the
 * client address a route handler sees comes from headers the client can set
 * (`X-Forwarded-For`): keying on it alone let an attacker reset the limit
 * by changing the header. When `DASHBOARD_CLIENT_IP_HEADER` names a header
 * that the operator's reverse proxy overwrites, failures are also counted
 * per client address, which slows one source spraying many usernames. A
 * global ceiling bounds the total rate either way.
 *
 * Like the session store this is in memory and per process.
 */

export const LOGIN_WINDOW_MS = 60_000;
export const MAX_FAILURES_PER_USERNAME = 5;
export const MAX_FAILURES_PER_CLIENT = 20;
export const MAX_FAILURES_GLOBAL = 100;
// Usernames in failed attempts are attacker-chosen. Past this many tracked
// keys the oldest are dropped so the map cannot grow without bound; the
// global ceiling still applies to anything dropped.
const MAX_TRACKED_KEYS = 10_000;

const STORE_KEY = Symbol.for("tollway.dashboard.login-failures");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: Map<string, number[]> };

function store(): Map<string, number[]> {
  const scope = globalThis as GlobalWithStore;
  let failures = scope[STORE_KEY];
  if (failures === undefined) {
    failures = new Map();
    scope[STORE_KEY] = failures;
  }
  return failures;
}

function recent(key: string, now: number): number[] {
  const failures = store();
  const kept = (failures.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  if (kept.length === 0) failures.delete(key);
  else failures.set(key, kept);
  return kept;
}

export type LoginSubject = { username: string; client: string | null };

function keys(subject: LoginSubject): { key: string; max: number }[] {
  const list = [
    { key: "global", max: MAX_FAILURES_GLOBAL },
    { key: `user:${subject.username.toLowerCase()}`, max: MAX_FAILURES_PER_USERNAME },
  ];
  if (subject.client !== null) {
    list.push({ key: `client:${subject.client}`, max: MAX_FAILURES_PER_CLIENT });
  }
  return list;
}

export function isRateLimited(subject: LoginSubject, now = Date.now()): boolean {
  return keys(subject).some(({ key, max }) => recent(key, now).length >= max);
}

export function recordFailure(subject: LoginSubject, now = Date.now()): void {
  const failures = store();
  for (const { key } of keys(subject)) {
    const list = recent(key, now);
    list.push(now);
    failures.set(key, list);
  }
  while (failures.size > MAX_TRACKED_KEYS) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

/**
 * The client address from the header the operator trusts, or null when
 * none is configured. The header must be one the reverse proxy sets itself
 * (for example `X-Real-IP`), never one it appends to: behind an appending
 * proxy, the start of `X-Forwarded-For` is whatever the client sent.
 */
export function trustedClientAddress(request: Request): string | null {
  const header = process.env.DASHBOARD_CLIENT_IP_HEADER;
  if (!header) return null;
  const value = request.headers.get(header)?.trim();
  return value ? value : null;
}

export function resetRateLimit(): void {
  store().clear();
}
