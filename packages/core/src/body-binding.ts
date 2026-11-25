import { bytesToBase64Url } from "./encoding.js";

/**
 * Binds a request body into the resource identity (#164). For a route that
 * sells what is in the body, such as an inference prompt, the identity is
 * the route's resource followed by the SHA-256 of the exact body bytes:
 *
 *   /infer#body-sha256=<base64url SHA-256, no padding>
 *
 * The `#` part is never sent in a URL, so a bound identity cannot collide
 * with a real path. The digest is over the bytes as sent, never re-encoded
 * JSON: two encodings of one object are two different bodies. A client
 * computes the same value with these functions before it pays.
 */

/** What separates the resource from the body digest in a bound identity. */
export const BODY_DIGEST_SEPARATOR = "#body-sha256=";

/** SHA-256 of the exact body bytes, base64url without padding. Runs on every runtime. */
export async function bodyDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToBase64Url(new Uint8Array(digest));
}

/** The resource identity for `resource` with `body` bound into it. */
export async function bindBodyToResource(resource: string, body: Uint8Array): Promise<string> {
  return `${resource}${BODY_DIGEST_SEPARATOR}${await bodyDigest(body)}`;
}
