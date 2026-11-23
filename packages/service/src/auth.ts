/**
 * API-key authentication. Keys are stored as SHA-256 hex digests, never as
 * the secret itself, so a leaked configuration or process dump does not hand
 * over a working key. Verification hashes the presented key with WebCrypto,
 * which every runtime Hono runs on provides, and compares digests without an
 * early return.
 */

import type { Context, Next } from "hono";
import { apiError } from "./http.js";

/** What a key may do: send metrics, or read them. */
export const serviceScopes = ["ingest", "read"] as const;

export type ServiceScope = (typeof serviceScopes)[number];

export type ServiceApiKey = {
  /** A name for this key, used in your own logs and rotation runbook. */
  id: string;
  /** Lowercase hex SHA-256 of the secret; see {@link hashApiKey}. */
  keyHash: string;
  scopes: ServiceScope[];
};

/** The SHA-256 hex digest to store in a {@link ServiceApiKey}. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare two hex digests without stopping at the first different character. */
function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Middleware that requires a valid bearer key with `scope`. A missing or
 * unknown key is 401; a known key without the scope is 403. The response
 * never says whether the key exists but is unprivileged in a way that helps
 * guess another, beyond the scope the caller asked for.
 */
export function requireScope(keys: readonly ServiceApiKey[], scope: ServiceScope) {
  return async (context: Context, next: Next): Promise<Response | undefined> => {
    const presented = bearerToken(context.req.header("Authorization"));
    if (!presented) {
      return context.json(
        apiError("unauthorized", "send the API key as Authorization: Bearer <key>"),
        401,
      );
    }
    const presentedHash = await hashApiKey(presented);
    const key = keys.find((candidate) => timingSafeEqualHex(candidate.keyHash, presentedHash));
    if (!key) {
      return context.json(apiError("unauthorized", "the API key is not valid"), 401);
    }
    if (!key.scopes.includes(scope)) {
      return context.json(
        apiError("forbidden", `this API key does not have the ${scope} scope`),
        403,
      );
    }
    await next();
    return undefined;
  };
}
