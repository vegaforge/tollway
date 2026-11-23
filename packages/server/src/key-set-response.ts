/**
 * Framework-agnostic helper that renders a key-set document as an HTTP
 * response (Issue #167). Every adapter (Express, Fastify, Next, Hono)
 * mounts this at a well-known path. The recommended location is
 * `/.well-known/tollway-receipt-keys.jwks`, but any URL works as long
 * as the verifier is pointed at it.
 *
 * The returned shape is a plain object so the adapter decides how to
 * send it. The body is already a JSON string, with content-type
 * `application/jwk-set+json` and a `Cache-Control` the verifier honours.
 */

import { type KeySetDocument, parseKeySetDocument, TollwayError } from "@vegaforge/tollway-core";

const DEFAULT_MAX_AGE_SECONDS = 300;

export type KeySetResponseOptions = {
  /**
   * Seconds the response is cached, a non-negative integer. A verifier
   * clamps it between its `minCacheMs` and `maxCacheMs`. This is the
   * longest a verifier may take to see a revocation, so keep it short.
   * Defaults to 300 (five minutes).
   */
  maxAgeSeconds?: number;
};

export type KeySetResponse = {
  status: 200;
  headers: {
    "content-type": "application/jwk-set+json";
    "cache-control": string;
  };
  body: string;
};

/**
 * Validates and serialises a key-set document for serving over HTTP.
 * Parsing at this boundary matters: an adapter that calls this passes
 * through its JSON body unchanged, so a document with a malformed entry
 * or a duplicate `kid` cannot reach a verifier.
 *
 * @throws TollwayError `invalid-key-set` for an invalid document or
 * `maxAgeSeconds`.
 */
export function renderKeySetResponse(
  document: KeySetDocument,
  options: KeySetResponseOptions = {},
): KeySetResponse {
  const parsed = parseKeySetDocument(document);
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new TollwayError(
      "invalid-key-set",
      `maxAgeSeconds must be a non-negative integer, got ${String(maxAge)}`,
    );
  }
  return {
    status: 200,
    headers: {
      "content-type": "application/jwk-set+json",
      "cache-control": `public, max-age=${maxAge}`,
    },
    body: JSON.stringify(parsed),
  };
}
