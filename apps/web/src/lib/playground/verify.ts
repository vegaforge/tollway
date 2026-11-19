import {
  base64UrlToBytes,
  Ed25519Verifier,
  type ReceiptVerification,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { z } from "zod";

/** Raw Ed25519 public keys are 32 bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

const jwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("OKP"),
        crv: z.literal("Ed25519"),
        kid: z.string().min(1),
        x: z.string().min(1),
      }),
    )
    .min(1),
});

/** What a service's read-only key route returns, for example `examples/next-paid-api`. */
const singleKeySchema = z.object({
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
});

const keyMapSchema = z.record(z.string().min(1), z.string().min(1));

type KeyParse = { ok: true; keys: Record<string, Uint8Array> } | { ok: false; reason: string };

function decodeKey(keyId: string, encoded: string): Uint8Array | string {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(encoded.trim().replace(/=+$/, ""));
  } catch {
    return `The public key for "${keyId}" is not base64url.`;
  }
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    return `The public key for "${keyId}" is ${bytes.length} bytes; an Ed25519 public key is ${ED25519_PUBLIC_KEY_BYTES}.`;
  }
  return bytes;
}

/**
 * Accepts a bare base64url public key (trusted for the receipt's own keyId),
 * a JWKS document with OKP Ed25519 keys, a `{ keyId, publicKey }` object, or
 * a map of keyId to base64url key.
 */
export function parseTrustedKeys(input: string, receiptKeyId: string): KeyParse {
  const text = input.trim();
  if (text === "") {
    return { ok: false, reason: "Paste a public key or a key-set JSON document." };
  }

  let entries: Array<[string, string]>;
  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch (error) {
      return {
        ok: false,
        reason: `The key set is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
      };
    }
    const jwks = jwksSchema.safeParse(json);
    const single = singleKeySchema.safeParse(json);
    const map = keyMapSchema.safeParse(json);
    if (jwks.success) {
      entries = jwks.data.keys.map((key) => [key.kid, key.x]);
    } else if (single.success) {
      entries = [[single.data.keyId, single.data.publicKey]];
    } else if (map.success && Object.keys(map.data).length > 0) {
      entries = Object.entries(map.data);
    } else {
      return {
        ok: false,
        reason:
          "The key set must be a JWKS document with OKP Ed25519 keys, a { keyId, publicKey } object, or a map of keyId to base64url key.",
      };
    }
  } else {
    entries = [[receiptKeyId, text]];
  }

  const keys: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of entries) {
    const decoded = decodeKey(keyId, encoded);
    if (typeof decoded === "string") {
      return { ok: false, reason: decoded };
    }
    keys[keyId] = decoded;
  }
  return { ok: true, keys };
}

/**
 * Verifies a receipt with `verifyReceipt` from `@vegaforge/tollway-core`,
 * the same function services and agents call. WebCrypto runs locally.
 */
export async function verifyPastedReceipt(
  receipt: unknown,
  keyInput: string,
  receiptKeyId: string,
): Promise<ReceiptVerification> {
  const parsed = parseTrustedKeys(keyInput, receiptKeyId);
  if (!parsed.ok) {
    return { valid: false, reason: parsed.reason };
  }
  if (!(receiptKeyId in parsed.keys)) {
    return {
      valid: false,
      reason: `None of the pasted keys has the receipt's keyId "${receiptKeyId}".`,
    };
  }
  return verifyReceipt(receipt, new Ed25519Verifier(parsed.keys));
}
