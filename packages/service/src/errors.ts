import { z } from "zod";

/**
 * The machine-readable codes the skeleton itself returns. Routes added later
 * (#225 to #228) may add their own codes; they keep the same body shape.
 * A code never changes once released: clients branch on it.
 */
export const serviceErrorCodes = [
  /** No usable `Authorization: Bearer <key>`, or the key is unknown or revoked. */
  "unauthorized",
  /** The key is valid but lacks the scope the route requires. */
  "forbidden",
  /** The path, query or body failed its schema, or the body is not JSON. */
  "invalid-request",
  /** No route matches the method and path. */
  "not-found",
  /** The request body is larger than `maxBodyBytes`. */
  "payload-too-large",
  /** A backing store failed its readiness check. */
  "not-ready",
  /** The resource is in a state the request cannot act on, such as closing a recovering channel. */
  "conflict",
  /** A channel close was attempted and did not complete; `details.status` is its current status. */
  "close-failed",
  /** An unexpected failure. The cause is logged, never returned. */
  "internal-error",
] as const;

export type ServiceErrorCode = (typeof serviceErrorCodes)[number];

/**
 * The one JSON shape every error response uses. `details` carries
 * structured context, for example the failing field paths of a validation
 * error. It never carries a key, a key hash, or a request header.
 */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Builds an {@link ErrorBody}. */
export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
