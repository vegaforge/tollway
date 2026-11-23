import type { MiddlewareHandler } from "hono";
import type { ApiKeyConfig, ApiKeyScope } from "./config.js";
import { errorBody } from "./errors.js";
import type { ServiceEnv } from "./types.js";

/**
 * API-key authentication for `/v1/*`.
 *
 * A key is presented as `Authorization: Bearer <key>`. The service hashes it
 * with SHA-256 through Web Crypto, so the same code runs on Node and edge
 * runtimes, and compares the digest with every configured hash in constant
 * time. The comparison never stops early, neither inside a digest nor across
 * the key list, so response time does not reveal how close a guess came or
 * which entry matched. Neither the key nor its hash appears in a response or
 * a log line.
 */

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of an API key: the value to configure as `sha256`. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Compares two equal-length strings without an early exit. */
function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}

/** The key a request authenticated with, as routes see it. Never the key itself. */
export type AuthenticatedKey = {
  name: string;
  scopes: readonly ApiKeyScope[];
};

// RFC 6750 token characters. Anything else in the credential is malformed.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/;

const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="tollway-service"' };

function unauthorized(message: string) {
  return errorBody("unauthorized", message);
}

/**
 * Requires a configured, unrevoked key on every request it guards, and
 * stores the key's name and scopes on the context as `apiKey`.
 */
export function authenticate(keys: readonly ApiKeyConfig[]): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || header === "") {
      return c.json(
        unauthorized("send the API key as Authorization: Bearer <key>"),
        401,
        CHALLENGE,
      );
    }
    const match = BEARER.exec(header.trim());
    const token = match?.[1];
    if (token === undefined) {
      return c.json(unauthorized("expected Authorization: Bearer <key>"), 401, CHALLENGE);
    }

    const presented = await hashApiKey(token);
    let found: ApiKeyConfig | undefined;
    for (const key of keys) {
      // Every entry is compared, so the time taken does not depend on which
      // entry, if any, matches.
      if (constantTimeEqual(key.sha256, presented) && found === undefined) found = key;
    }
    if (found === undefined) {
      return c.json(unauthorized("the API key is not recognised"), 401, CHALLENGE);
    }
    if (found.revoked === true) {
      return c.json(unauthorized("the API key has been revoked"), 401, CHALLENGE);
    }
    c.set("apiKey", { name: found.name, scopes: found.scopes });
    await next();
  };
}

/** Requires the authenticated key to carry `scope`; answers 403 when it does not. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    const key = c.get("apiKey");
    if (!key.scopes.includes(scope)) {
      return c.json(errorBody("forbidden", `this API key does not have the ${scope} scope`), 403);
    }
    await next();
  };
}
