/**
 * Framework-agnostic helper that renders a key-set document as an HTTP
 * response (Issue #167). Every adapter (Express, Fastify, Next, Hono)
 * mounts this at a well-known path - the recommended location is
 * `/.well-known/tollway-receipt-keys.jwks`, but any URL works as long
 * as the verifier is pointed at it.
 *
 * The returned shape is a plain object so the adapter decides how to
 * send it. The body is already a JSON string, with content-type
 * `application/jwk-set+json` and a `Cache-Control` the verifier honours.
 */

import { type KeySetDocument, keySetDocumentSchema } from "@vegaforge/tollway-core";

const DEFAULT_MAX_AGE_SECONDS = 300;

export type KeySetResponseOptions = {
  /**
   * Seconds the response is cached. A verifier clamps between its
   * `minCacheMs` and `maxCacheMs`, so a conservative value here is
   * fine. Defaults to 300 (five minutes).
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
 * cannot reach a verifier that trusts the shape.
 */
export function renderKeySetResponse(
  document: KeySetDocument,
  options: KeySetResponseOptions = {},
): KeySetResponse {
  const parsed = keySetDocumentSchema.parse(document);
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  return {
    status: 200,
    headers: {
      "content-type": "application/jwk-set+json",
      "cache-control": `public, max-age=${maxAge}`,
    },
    body: JSON.stringify(parsed),
  };
}
