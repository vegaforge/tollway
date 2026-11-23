import { base64UrlToBytes } from "../encoding.js";

/**
 * The receipt signature algorithms Tollway knows, in one place (Issue #169).
 * Every signer, verifier and key-set entry takes its identifiers from here.
 *
 * - `Ed25519` is the value receipts have carried since v1. `Ed25519Signer`
 *   still writes it, so every receipt signed before #167 keeps its bytes.
 * - `EdDSA` is the JOSE name (RFC 8037) for the same algorithm. Key-set
 *   entries use it in `alg`, and a verifier treats the two spellings alike.
 * - `ES256` is the JOSE name for ECDSA over P-256 with SHA-256. The signature
 *   is IEEE P1363 `r || s` with `s` in the low half.
 *
 * Anything else, `none` included, is unknown and fails verification with a
 * reason. It never throws.
 */
export const ED25519_ALGORITHM = "Ed25519";
export const EDDSA_ALGORITHM = "EdDSA";
export const ES256_ALGORITHM = "ES256";

export const RECEIPT_ALGORITHMS = [ED25519_ALGORITHM, EDDSA_ALGORITHM, ES256_ALGORITHM] as const;

/** A receipt signature algorithm identifier; see {@link RECEIPT_ALGORITHMS}. */
export type ReceiptAlgorithm = (typeof RECEIPT_ALGORITHMS)[number];

/** True when `name` is one of {@link RECEIPT_ALGORITHMS}. */
export function isReceiptAlgorithm(name: string): name is ReceiptAlgorithm {
  return (RECEIPT_ALGORITHMS as readonly string[]).includes(name);
}

/**
 * Folds the two spellings of Ed25519 into one, so `Ed25519` on a receipt
 * matches `EdDSA` on a key record. Other names are returned unchanged.
 */
export function canonicalAlgorithm(name: string): string {
  return name === ED25519_ALGORITHM ? EDDSA_ALGORITHM : name;
}

/** Bytes in an Ed25519 public key, and in each P-256 coordinate and scalar. */
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const P256_SCALAR_BYTES = 32;
export const P256_SIGNATURE_BYTES = P256_SCALAR_BYTES * 2;

/** The P-256 group order n (SEC 2, FIPS 186-4), and n / 2 for the low-S rule. */
export const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
export const P256_HALF_N = P256_N >> 1n;

/** Reads an unsigned big-endian integer. */
export function readScalar(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** Writes `value` as a 32-byte big-endian scalar at `offset`. */
export function writeScalar(value: bigint, buffer: Uint8Array, offset: number): void {
  let cursor = value;
  for (let i = P256_SCALAR_BYTES - 1; i >= 0; i -= 1) {
    buffer[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
}

/**
 * True when the `s` half of a P1363 signature is above n / 2. ECDSA accepts
 * both `s` and `n - s`, so Tollway signs with the low half and refuses the
 * high half, which leaves each receipt one valid signature encoding.
 */
export function isHighS(signature: Uint8Array): boolean {
  return readScalar(signature.subarray(P256_SCALAR_BYTES)) > P256_HALF_N;
}

/** The P-256 parameters WebCrypto takes for import and verify. */
const P256_IMPORT = { name: "ECDSA", namedCurve: "P-256" } as const;
const P256_VERIFY = { name: "ECDSA", hash: "SHA-256" } as const;

/** Imports a raw 32-byte Ed25519 public key for verification. Throws when it is malformed. */
export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, ED25519_ALGORITHM, false, ["verify"]);
}

/**
 * Imports a P-256 public key from its base64url JWK coordinates. WebCrypto
 * checks that the point is on the curve. Throws when it is malformed.
 */
export async function importP256PublicKey(x: string, y: string): Promise<CryptoKey> {
  if (
    base64UrlToBytes(x).length !== P256_SCALAR_BYTES ||
    base64UrlToBytes(y).length !== P256_SCALAR_BYTES
  ) {
    throw new Error(`P-256 coordinates must be ${P256_SCALAR_BYTES} bytes each`);
  }
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, P256_IMPORT, false, [
    "verify",
  ]);
}

/** Checks an Ed25519 signature with an imported key. */
export async function verifyEd25519(
  key: CryptoKey,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    ED25519_ALGORITHM,
    key,
    signature as BufferSource,
    message as BufferSource,
  );
}

/**
 * Checks an ES256 signature with an imported key. A signature that is not 64
 * bytes, or whose `s` is in the high half, fails before WebCrypto sees it.
 */
export async function verifyEs256(
  key: CryptoKey,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (signature.length !== P256_SIGNATURE_BYTES) return false;
  if (isHighS(signature)) return false;
  return crypto.subtle.verify(P256_VERIFY, key, signature as BufferSource, message as BufferSource);
}

export { P256_IMPORT, P256_VERIFY };
