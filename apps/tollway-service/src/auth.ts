/**
 * Service-level API key authentication.
 *
 * The service reads `SERVICE_API_KEY` from the environment and expects
 * callers to present it in `Authorization: Bearer <key>`. Scopes are
 * embedded in the key configuration; for now only `read` is defined.
 *
 * The dashboard proxy adds this header on the server side, so the key
 * never reaches the browser (see apps/dashboard/src/app/api/events/stream/route.ts).
 */

import type { Context } from "hono";

export type Scope = "read" | "write";

const BEARER_PREFIX = "Bearer ";

function configuredKey(): string {
  const key = process.env.SERVICE_API_KEY;
  if (!key || key.length < 16) {
    throw new Error("SERVICE_API_KEY must be at least 16 characters");
  }
  return key;
}

/** Hono middleware that requires a valid API key with at least `scope`. */
export function requireApiKey(scope: Scope) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    let expected: string;
    try {
      expected = configuredKey();
    } catch {
      return c.json({ error: "Service is misconfigured" }, 500);
    }

    const authorization = c.req.header("authorization") ?? "";
    if (!authorization.startsWith(BEARER_PREFIX)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const presented = authorization.slice(BEARER_PREFIX.length);
    if (!timingSafeEqual(presented, expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Scope check: for now every valid key has both read and write.
    // A future key-store can attach per-key scopes; the middleware
    // interface does not change.
    if (scope === "read" || scope === "write") {
      await next();
      return;
    }
    return c.json({ error: "Forbidden" }, 403);
  };
}

/**
 * Constant-time string comparison to prevent timing-based key enumeration.
 * Both strings are encoded to Uint8Array; if lengths differ, we still
 * compare with a dummy buffer of the same length so the time is constant.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // Compare anyway to consume similar time, then return false.
    let _diff = 0;
    const dummy = new Uint8Array(bb.byteLength);
    for (let i = 0; i < dummy.length; i++) _diff |= (ab[i] ?? 0) ^ (dummy[i] ?? 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
