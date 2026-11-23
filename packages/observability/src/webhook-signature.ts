/**
 * HMAC-SHA256 signing for webhook deliveries, and the receiver-side verifier.
 *
 * The header follows the `t=<unix seconds>,v1=<hex>` pattern so a future `v2`
 * can be added without breaking receivers. The signature covers the exact
 * bytes sent, so a signature is only valid for the body it was issued with.
 * This is the signing design from #104, which #220 depends on. See
 * docs/webhook-delivery.md.
 */

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = "Tollway-Signature";

/** Why a signature was refused. The secret never appears in a reason. */
export type SignatureFailureReason =
  | "malformed-header"
  | "timestamp-out-of-tolerance"
  | "signature-mismatch";

export type SignatureVerification =
  | { valid: true }
  | { valid: false; reason: SignatureFailureReason };

const SIGNATURE_PATTERN = /^t=(\d+),v1=([0-9a-f]{64})$/;

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

/** Compares two strings without stopping at the first differing character. */
function constantTimeEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Signs a webhook body for the current second. Call it at send time, not at
 * enqueue time: a retry needs a fresh timestamp so a receiver that enforces a
 * tolerance accepts it.
 */
export async function signWebhookPayload(input: {
  secret: string;
  /** The exact body that will be POSTed. */
  payload: string;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: number;
}): Promise<string> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  return `t=${timestamp},v1=${await hmacHex(input.secret, `${timestamp}.${input.payload}`)}`;
}

/**
 * Verifies a `Tollway-Signature` header against the body the receiver read.
 * Rejects a header older or newer than `toleranceSeconds` (default 300) so a
 * captured delivery cannot be replayed later, and compares in constant time.
 * The body must be the raw bytes received; parsing and re-serializing it
 * usually changes them.
 */
export async function verifyWebhookSignature(input: {
  payload: string;
  header: string;
  secret: string;
  /** Accepted clock skew in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: number;
}): Promise<SignatureVerification> {
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError("toleranceSeconds must be a non-negative integer");
  }
  const match = SIGNATURE_PATTERN.exec(input.header);
  if (!match) {
    return { valid: false, reason: "malformed-header" };
  }
  const timestamp = Number(match[1]);
  const provided = match[2] ?? "";
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp-out-of-tolerance" };
  }
  const expected = await hmacHex(input.secret, `${timestamp}.${input.payload}`);
  return constantTimeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: "signature-mismatch" };
}
