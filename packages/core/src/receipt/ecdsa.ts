/**
 * ECDSA P-256 receipt signing and verification (Issue #169).
 *
 * WebCrypto's `ECDSA` with `namedCurve: "P-256"` outputs IEEE P1363
 * (`r || s`, 64 bytes for P-256) and accepts the same form at verify.
 * Hardware wallets, HSMs and KMS backends often emit ASN.1 DER
 * instead, so this module exposes a strict DER-to-P1363 converter
 * for KMS-backed signers.
 *
 * Wire format: Tollway's receipt carries the signature base64url of
 * P1363 `r || s`. The verifier rejects malleable high-S signatures
 * (`s > n/2`) so each receipt has one valid signature encoding.
 */

import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import type { ReceiptSigner, ReceiptVerifier } from "./signer.js";

/** JOSE name for ECDSA P-256 with SHA-256. Used in every verifier check. */
export const ECDSA_P256_ALG = "ES256";

/** The P-256 group order n (hex; from SEC2 / NIST FIPS 186-4). */
const P256_N_HEX = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";

const P256_N = BigInt(`0x${P256_N_HEX}`);
const P256_HALF_N = P256_N >> 1n;
const P256_SCALAR_BYTES = 32;

/**
 * Converts an IEEE P1363 `r || s` signature (the shape WebCrypto emits
 * and expects) into base64url. The caller normally has the raw bytes
 * directly; the helper exists mostly for symmetry with the DER helpers.
 */
export function p1363ToBase64Url(signature: Uint8Array): string {
  if (signature.length !== P256_SCALAR_BYTES * 2) {
    throw new TollwayError(
      "invalid-signing-key",
      `P1363 ECDSA P-256 signature must be ${P256_SCALAR_BYTES * 2} bytes, got ${signature.length}`,
    );
  }
  return bytesToBase64Url(signature);
}

/**
 * Converts an ASN.1 DER ECDSA signature into IEEE P1363 `r || s`. The
 * parser is strict:
 *   - the outer tag is 0x30 and the length matches the remaining bytes;
 *   - each INTEGER is 0x02-tagged, non-negative (no 0x80 high bit after
 *     the leading-zero strip), and is not encoded with non-minimal
 *     leading zeros;
 *   - neither r nor s exceeds the P-256 scalar size (32 bytes).
 * Trailing bytes after the second INTEGER fail parsing. Rejecting all
 * of these keeps a malleable or hand-crafted signature from being
 * accepted alongside its canonical form.
 */
export function derToP1363(der: Uint8Array): Uint8Array {
  let cursor = 0;
  if (der[cursor] !== 0x30) {
    throw new TollwayError("invalid-signing-key", "DER ECDSA signature: expected SEQUENCE (0x30)");
  }
  cursor += 1;
  const sequenceLength = readDerLength(der, cursor);
  cursor += sequenceLength.consumed;
  if (cursor + sequenceLength.value !== der.length) {
    throw new TollwayError(
      "invalid-signing-key",
      "DER ECDSA signature: trailing bytes after SEQUENCE",
    );
  }
  const r = readDerInteger(der, cursor);
  cursor += r.consumed;
  const s = readDerInteger(der, cursor);
  cursor += s.consumed;
  if (cursor !== der.length) {
    throw new TollwayError(
      "invalid-signing-key",
      "DER ECDSA signature: trailing bytes after INTEGERs",
    );
  }
  if (r.bytes.length > P256_SCALAR_BYTES || s.bytes.length > P256_SCALAR_BYTES) {
    throw new TollwayError(
      "invalid-signing-key",
      "DER ECDSA signature: r or s longer than the P-256 scalar size",
    );
  }
  const out = new Uint8Array(P256_SCALAR_BYTES * 2);
  out.set(r.bytes, P256_SCALAR_BYTES - r.bytes.length);
  out.set(s.bytes, P256_SCALAR_BYTES * 2 - s.bytes.length);
  return out;
}

function readDerLength(buffer: Uint8Array, offset: number): { value: number; consumed: number } {
  if (offset >= buffer.length) {
    throw new TollwayError("invalid-signing-key", "DER: unexpected end of buffer at length");
  }
  const first = buffer[offset];
  if (first === undefined) {
    throw new TollwayError("invalid-signing-key", "DER: unexpected end of buffer at length");
  }
  if (first < 0x80) return { value: first, consumed: 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) {
    throw new TollwayError("invalid-signing-key", "DER: invalid length encoding");
  }
  let value = 0;
  for (let i = 0; i < numBytes; i += 1) {
    const byte = buffer[offset + 1 + i];
    if (byte === undefined) {
      throw new TollwayError("invalid-signing-key", "DER: truncated length");
    }
    value = (value << 8) | byte;
  }
  return { value, consumed: 1 + numBytes };
}

function readDerInteger(
  buffer: Uint8Array,
  offset: number,
): { bytes: Uint8Array; consumed: number } {
  if (buffer[offset] !== 0x02) {
    throw new TollwayError("invalid-signing-key", "DER: expected INTEGER (0x02)");
  }
  const length = readDerLength(buffer, offset + 1);
  const start = offset + 1 + length.consumed;
  const end = start + length.value;
  if (end > buffer.length) {
    throw new TollwayError("invalid-signing-key", "DER: INTEGER length exceeds buffer");
  }
  const raw = buffer.subarray(start, end);
  if (raw.length === 0) {
    throw new TollwayError("invalid-signing-key", "DER INTEGER: empty content");
  }
  // Non-minimal encodings: a leading 0x00 is only allowed to keep the
  // integer positive when the next byte has the high bit set.
  if (raw.length > 1 && raw[0] === 0x00 && (raw[1] ?? 0) < 0x80) {
    throw new TollwayError("invalid-signing-key", "DER INTEGER: non-minimal leading zero");
  }
  if ((raw[0] ?? 0) >= 0x80) {
    throw new TollwayError(
      "invalid-signing-key",
      "DER INTEGER: negative value (high bit set) is not a valid ECDSA scalar",
    );
  }
  // Strip the leading zero when it was there only to keep the integer
  // non-negative.
  const bytes = raw[0] === 0x00 ? raw.subarray(1) : raw;
  return { bytes, consumed: 1 + length.consumed + length.value };
}

/**
 * Reads an unsigned big-endian integer from a slice of a P1363 signature
 * as a bigint. Used to pick up `s` and check for the high-S malleability
 * window.
 */
function readScalar(buffer: Uint8Array): bigint {
  let value = 0n;
  for (const byte of buffer) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * True when `s > n/2`. The P1363 signature is the concatenation of two
 * 32-byte scalars `r || s`. ECDSA's malleability means both `s` and
 * `n - s` verify against the same key; we reject the upper half so each
 * receipt has one valid signature encoding.
 */
function isHighS(signature: Uint8Array): boolean {
  const s = readScalar(signature.subarray(P256_SCALAR_BYTES));
  return s > P256_HALF_N;
}

/**
 * The public half of a P-256 key in JWK form, with the `kid`, `alg` and
 * `use` fields a key-set entry needs on top of the raw material.
 */
export type P256PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

export class EcdsaP256Signer implements ReceiptSigner {
  readonly algorithm = ECDSA_P256_ALG;
  readonly keyId: string;
  readonly publicJwkBytes: { x: string; y: string };
  private readonly privateKey: CryptoKey;

  private constructor(
    keyId: string,
    privateKey: CryptoKey,
    publicJwkBytes: { x: string; y: string },
  ) {
    this.keyId = keyId;
    this.privateKey = privateKey;
    this.publicJwkBytes = publicJwkBytes;
  }

  /** Generates a P-256 keypair. */
  static async generate(keyId?: string): Promise<EcdsaP256Signer> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new TollwayError(
        "invalid-signing-key",
        "generated P-256 keypair has no public coordinates",
      );
    }
    const id = keyId ?? bytesToBase64Url(await rawFromJwk(jwk));
    return new EcdsaP256Signer(id, pair.privateKey, { x: jwk.x, y: jwk.y });
  }

  /**
   * Loads a persisted P-256 private key from a JWK. The private half is
   * validated against the declared public half, and never echoed into
   * error messages.
   */
  static async fromJwk(jwk: Record<string, unknown>, keyId?: string): Promise<EcdsaP256Signer> {
    if (jwk.kty !== "EC") {
      throw new TollwayError(
        "invalid-signing-key",
        `receipt signing JWK has kty ${String(jwk.kty)}, expected "EC"`,
      );
    }
    if (jwk.crv !== "P-256") {
      throw new TollwayError(
        "invalid-signing-key",
        `receipt signing JWK has crv ${String(jwk.crv)}, expected "P-256"`,
      );
    }
    if (typeof jwk.d !== "string" || jwk.d.length === 0) {
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK has no private half (`d` is missing)",
      );
    }
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK has no complete public half",
      );
    }
    let privateKey: CryptoKey;
    try {
      const extractable = await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
      const exported = await crypto.subtle.exportKey("jwk", extractable);
      if (exported.x !== jwk.x || exported.y !== jwk.y) {
        throw new TollwayError(
          "invalid-signing-key",
          "receipt signing JWK private half does not match its declared public half",
        );
      }
      privateKey = await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    } catch (error) {
      if (error instanceof TollwayError) throw error;
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK could not be imported as a P-256 private key",
      );
    }
    const id = keyId ?? bytesToBase64Url(await rawFromJwk(jwk as JsonWebKey));
    return new EcdsaP256Signer(id, privateKey, { x: jwk.x, y: jwk.y });
  }

  /**
   * The public half as a JWK with `kid`, `alg` and `use`, ready for a
   * key-set document.
   */
  publicJwk(): P256PublicJwk {
    return {
      kty: "EC",
      crv: "P-256",
      x: this.publicJwkBytes.x,
      y: this.publicJwkBytes.y,
      kid: this.keyId,
      alg: ECDSA_P256_ALG,
      use: "sig",
    };
  }

  /**
   * Signs a message and returns the IEEE P1363 `r || s` encoding, with
   * `s` normalised into the low half so the resulting signature is not
   * subject to the ECDSA malleability window.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.privateKey,
        message as BufferSource,
      ),
    );
    if (raw.length !== P256_SCALAR_BYTES * 2) {
      throw new TollwayError(
        "invalid-signing-key",
        `WebCrypto returned ${raw.length}-byte ECDSA signature, expected ${P256_SCALAR_BYTES * 2}`,
      );
    }
    const s = readScalar(raw.subarray(P256_SCALAR_BYTES));
    if (s <= P256_HALF_N) return raw;
    // Normalise s to n - s so the verifier always sees the canonical
    // encoding; we then reject high-S at verify as a double-check.
    const normalisedS = P256_N - s;
    const out = new Uint8Array(raw);
    writeScalar(normalisedS, out, P256_SCALAR_BYTES);
    return out;
  }
}

function writeScalar(value: bigint, buffer: Uint8Array, offset: number): void {
  let cursor = value;
  for (let i = P256_SCALAR_BYTES - 1; i >= 0; i -= 1) {
    buffer[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
}

async function rawFromJwk(jwk: JsonWebKey): Promise<Uint8Array> {
  // Derive a stable id by concatenating x and y; WebCrypto does not
  // expose a "raw" export for an EC public key via JWK, so we build the
  // 65-byte uncompressed form ourselves (0x04 || x || y).
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TollwayError("invalid-signing-key", "P-256 JWK is missing x or y");
  }
  const xb = base64UrlToBytes(jwk.x);
  const yb = base64UrlToBytes(jwk.y);
  const out = new Uint8Array(1 + xb.length + yb.length);
  out[0] = 0x04;
  out.set(xb, 1);
  out.set(yb, 1 + xb.length);
  return out;
}

/**
 * Verifies a single trusted P-256 public key. Rejects any non-ES256
 * algorithm, rejects high-S signatures (defense against malleability),
 * and never promotes an unknown key id to success.
 */
export class EcdsaP256Verifier implements ReceiptVerifier {
  private readonly keys = new Map<string, { x: string; y: string }>();

  constructor(entries: Record<string, { x: string; y: string }>) {
    for (const [keyId, jwk] of Object.entries(entries)) {
      this.keys.set(keyId, jwk);
    }
  }

  static forSigner(signer: EcdsaP256Signer): EcdsaP256Verifier {
    return new EcdsaP256Verifier({ [signer.keyId]: signer.publicJwkBytes });
  }

  async verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean> {
    if (input.algorithm !== ECDSA_P256_ALG) return false;
    const jwkBytes = this.keys.get(input.keyId);
    if (!jwkBytes) return false;
    if (input.signature.length !== P256_SCALAR_BYTES * 2) return false;
    if (isHighS(input.signature)) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: jwkBytes.x,
        y: jwkBytes.y,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      input.signature as BufferSource,
      input.message as BufferSource,
    );
  }
}
