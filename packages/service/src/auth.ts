import type { Context, MiddlewareHandler } from "hono";
import type { ApiKeyConfig, ApiKeyScope, OperatorKeyConfig } from "./config.js";
import { errorBody } from "./errors.js";
import { constantTimeEqual, type TenantScope } from "./tenancy.js";
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

/** The tenant key a request authenticated with, as routes see it. Never the key itself. */
export type AuthenticatedKey = {
  name: string;
  orgId: string;
  projectId: string;
  scopes: readonly ApiKeyScope[];
};

/** The operator key an admin request authenticated with. Never the key itself. */
export type AuthenticatedOperator = {
  name: string;
};

/** Scope requirement for a `/v1/*` route. */
export type RouteScope = ApiKeyScope | "operator" | null;

/** Reads the verified tenant key on a tenant route, throwing if middleware was bypassed. */
export function requireTenantKey(c: Context<ServiceEnv>): AuthenticatedKey {
  const key = c.get("apiKey");
  if (key === undefined) {
    throw new Error("route expected an authenticated tenant API key");
  }
  return key;
}

/** Extracts the authenticated key's `{ orgId, projectId }` scope. */
export function tenantOf(c: Context<ServiceEnv>): TenantScope {
  const key = requireTenantKey(c);
  return { orgId: key.orgId, projectId: key.projectId };
}

// RFC 6750 token characters. Anything else in the credential is malformed.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/;

const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="tollway-service"' };

function unauthorized(message: string) {
  return errorBody("unauthorized", message);
}

type MatchedCredential =
  | { kind: "tenant"; entry: ApiKeyConfig }
  | { kind: "operator"; entry: OperatorKeyConfig };

/**
 * Requires a configured, unrevoked key on every request it guards, and stores
 * the key's metadata on the context (`apiKey` for tenant keys, `operatorKey`
 * for cross-tenant operator keys).
 */
export function authenticate(
  keys: readonly ApiKeyConfig[],
  operatorKeys: readonly OperatorKeyConfig[] = [],
): MiddlewareHandler<ServiceEnv> {
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
    let found: MatchedCredential | undefined;
    for (const key of keys) {
      // Every entry is compared, so the time taken does not depend on which
      // entry, if any, matches.
      if (constantTimeEqual(key.sha256, presented) && found === undefined) {
        found = { kind: "tenant", entry: key };
      }
    }
    for (const key of operatorKeys) {
      if (constantTimeEqual(key.sha256, presented) && found === undefined) {
        found = { kind: "operator", entry: key };
      }
    }
    if (found === undefined) {
      return c.json(unauthorized("the API key is not recognised"), 401, CHALLENGE);
    }
    if (found.entry.revoked === true) {
      return c.json(unauthorized("the API key has been revoked"), 401, CHALLENGE);
    }
    if (found.kind === "tenant") {
      c.set("apiKey", {
        name: found.entry.name,
        orgId: found.entry.orgId,
        projectId: found.entry.projectId,
        scopes: found.entry.scopes,
      });
    } else {
      c.set("operatorKey", { name: found.entry.name });
    }
    await next();
  };
}

/**
 * Enforces the route's scope and separates tenant keys from operator keys:
 * operator keys may only call `"operator"` routes, and tenant keys may never
 * call `"operator"` routes even if they hold the `"admin"` scope.
 */
export function requireScope(scope: RouteScope): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    if (scope === "operator") {
      if (c.get("operatorKey") === undefined) {
        return c.json(errorBody("forbidden", "this route requires an operator key"), 403);
      }
      await next();
      return;
    }

    const key = c.get("apiKey");
    if (key === undefined) {
      return c.json(errorBody("forbidden", "operator keys cannot access tenant routes"), 403);
    }
    if (scope !== null && !key.scopes.includes(scope)) {
      return c.json(errorBody("forbidden", `this API key does not have the ${scope} scope`), 403);
    }
    await next();
  };
}
