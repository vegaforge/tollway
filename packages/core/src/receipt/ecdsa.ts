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
import {
  ES256_ALGORITHM,
  importP256PublicKey,
  P256_HALF_N,
  P256_IMPORT,
  P256_N,
  P256_SCALAR_BYTES,
  P256_SIGNATURE_BYTES,
  readScalar,
  verifyEs256,
  writeScalar,
} from "./algorithms.js";
import type { ReceiptSigner, ReceiptVerifier, SignatureInput } from "./signer.js";

/** JOSE name for ECDSA P-256 with SHA-256; see `algorithms.ts`. */
export const ECDSA_P256_ALG = ES256_ALGORITHM;

function encodingError(message: string): TollwayError {
  return new TollwayError("invalid-signature-encoding", message);
}

/**
 * Converts an IEEE P1363 `r || s` signature (the shape WebCrypto emits
 * and expects) into base64url. The caller normally has the raw bytes
 * directly; the helper exists mostly for symmetry with the DER helpers.
 */
export function p1363ToBase64Url(signature: Uint8Array): string {
  if (signature.length !== P256_SIGNATURE_BYTES) {
    throw encodingError(
      `P1363 ECDSA P-256 signature must be ${P256_SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }
  return bytesToBase64Url(signature);
}

/**
 * Converts an ASN.1 DER ECDSA signature into IEEE P1363 `r || s`. The
 * parser is strict, because a KMS-backed signer relies on it to refuse
 * anything that is not exactly one canonical DER signature:
 *   - the outer tag is 0x30 and its length covers the rest of the input,
 *     with no trailing bytes;
 *   - every length is in DER's minimal form: short form below 128, and a
 *     long form only for 128 or more, without a leading zero byte;
 *   - each INTEGER is 0x02-tagged, non-empty, non-negative, and has no
 *     non-minimal leading zero;
 *   - r and s are each in the range 1 to n - 1, where n is the P-256 order.
 * Every failure throws `invalid-signature-encoding`. The result may still
 * have a high `s`; {@link EcdsaP256Signer.sign} normalises its own output,
 * and a KMS signer should apply {@link normaliseLowS} before publishing.
 */
export function derToP1363(der: Uint8Array): Uint8Array {
  let cursor = 0;
  if (der[cursor] !== 0x30) {
    throw encodingError("DER ECDSA signature: expected SEQUENCE (0x30)");
  }
  cursor += 1;
  const sequenceLength = readDerLength(der, cursor);
  cursor += sequenceLength.consumed;
  if (cursor + sequenceLength.value !== der.length) {
    throw encodingError("DER ECDSA signature: SEQUENCE length does not match the input");
  }
  const r = readDerInteger(der, cursor);
  cursor += r.consumed;
  const s = readDerInteger(der, cursor);
  cursor += s.consumed;
  if (cursor !== der.length) {
    throw encodingError("DER ECDSA signature: trailing bytes after INTEGERs");
  }
  for (const [name, scalar] of [
    ["r", r.bytes],
    ["s", s.bytes],
  ] as const) {
    if (scalar.length > P256_SCALAR_BYTES) {
      throw encodingError(`DER ECDSA signature: ${name} is longer than the P-256 scalar size`);
    }
    const value = readScalar(scalar);
    if (value === 0n) {
      throw encodingError(`DER ECDSA signature: ${name} is zero`);
    }
    if (value >= P256_N) {
      throw encodingError(`DER ECDSA signature: ${name} is not below the P-256 order`);
    }
  }
  const out = new Uint8Array(P256_SIGNATURE_BYTES);
  out.set(r.bytes, P256_SCALAR_BYTES - r.bytes.length);
  out.set(s.bytes, P256_SIGNATURE_BYTES - s.bytes.length);
  return out;
}

/**
 * Returns a P1363 signature with `s` moved into the low half (`n - s` when
 * `s > n / 2`). Both encodings verify, and Tollway's verifiers only accept
 * the low one, so a signer that gets its signature from a KMS runs it
 * through this after {@link derToP1363}.
 */
export function normaliseLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== P256_SIGNATURE_BYTES) {
    throw encodingError(
      `P1363 ECDSA P-256 signature must be ${P256_SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }
  const s = readScalar(signature.subarray(P256_SCALAR_BYTES));
  if (s <= P256_HALF_N) return signature;
  const out = new Uint8Array(signature);
  writeScalar(P256_N - s, out, P256_SCALAR_BYTES);
  return out;
}

function readDerLength(buffer: Uint8Array, offset: number): { value: number; consumed: number } {
  const first = buffer[offset];
  if (first === undefined) {
    throw encodingError("DER: unexpected end of input at a length");
  }
  if (first < 0x80) return { value: first, consumed: 1 };
  const numBytes = first & 0x7f;
  // An ECDSA P-256 signature is at most 72 bytes, so two length bytes are
  // already more than any valid input needs; 0x80 itself is the indefinite
  // form, which DER forbids.
  if (numBytes === 0 || numBytes > 2) {
    throw encodingError("DER: invalid length encoding");
  }
  let value = 0;
  for (let i = 0; i < numBytes; i += 1) {
    const byte = buffer[offset + 1 + i];
    if (byte === undefined) {
      throw encodingError("DER: truncated length");
    }
    if (i === 0 && byte === 0) {
      throw encodingError("DER: non-minimal length (leading zero byte)");
    }
    value = (value << 8) | byte;
  }
  if (value < 0x80) {
    throw encodingError("DER: non-minimal length (long form for a value below 128)");
  }
  return { value, consumed: 1 + numBytes };
}

function readDerInteger(
  buffer: Uint8Array,
  offset: number,
): { bytes: Uint8Array; consumed: number } {
  if (buffer[offset] !== 0x02) {
    throw encodingError("DER: expected INTEGER (0x02)");
  }
  const length = readDerLength(buffer, offset + 1);
  const start = offset + 1 + length.consumed;
  const end = start + length.value;
  if (end > buffer.length) {
    throw encodingError("DER: INTEGER length exceeds the input");
  }
  const raw = buffer.subarray(start, end);
  if (raw.length === 0) {
    throw encodingError("DER INTEGER: empty content");
  }
  // A leading 0x00 is only allowed to keep the integer positive when the
  // next byte has the high bit set.
  if (raw.length > 1 && raw[0] === 0x00 && (raw[1] ?? 0) < 0x80) {
    throw encodingError("DER INTEGER: non-minimal leading zero");
  }
  if ((raw[0] ?? 0) >= 0x80) {
    throw encodingError("DER INTEGER: negative value (high bit set) is not a valid ECDSA scalar");
  }
  const bytes = raw[0] === 0x00 ? raw.subarray(1) : raw;
  return { bytes, consumed: 1 + length.consumed + length.value };
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

  /**
   * Generates a P-256 keypair. The private key is not extractable; the
   * public key always is, which is all `publicJwk()` needs.
   */
  static async generate(keyId?: string): Promise<EcdsaP256Signer> {
    const pair = (await crypto.subtle.generateKey(P256_IMPORT, false, [
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
    const id = keyId ?? bytesToBase64Url(uncompressedPoint(jwk.x, jwk.y));
    return new EcdsaP256Signer(id, pair.privateKey, { x: jwk.x, y: jwk.y });
  }

  /**
   * Loads a persisted P-256 private key from a PKCS#8 DER document, the
   * form `crypto.subtle.exportKey("pkcs8", ...)`, `openssl pkcs8 -topk8
   * -outform DER` and most KMS exports produce. `encodedKey` is the DER as
   * bytes or as base64url without padding. The key is imported extractable
   * once to read its public half, then again without extraction for
   * signing.
   *
   * @throws TollwayError with code `invalid-signing-key` when the input is
   * not a P-256 private key. The message never contains the key.
   */
  static async fromPkcs8(
    encodedKey: Uint8Array | string,
    keyId?: string,
  ): Promise<EcdsaP256Signer> {
    let der: Uint8Array;
    if (typeof encodedKey === "string") {
      const text = encodedKey.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(text)) {
        throw new TollwayError(
          "invalid-signing-key",
          "receipt signing key must be base64url (A-Z, a-z, 0-9, - and _, no padding)",
        );
      }
      der = base64UrlToBytes(text);
    } else {
      der = encodedKey;
    }
    let privateKey: CryptoKey;
    let x: string;
    let y: string;
    try {
      const extractable = await crypto.subtle.importKey(
        "pkcs8",
        der as BufferSource,
        P256_IMPORT,
        true,
        ["sign"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", extractable);
      if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
        throw new TollwayError("invalid-signing-key", "receipt signing key has no public half");
      }
      x = jwk.x;
      y = jwk.y;
      privateKey = await crypto.subtle.importKey("pkcs8", der as BufferSource, P256_IMPORT, false, [
        "sign",
      ]);
    } catch (error) {
      if (error instanceof TollwayError) throw error;
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing key could not be imported as a P-256 PKCS#8 private key",
      );
    }
    const id = keyId ?? bytesToBase64Url(uncompressedPoint(x, y));
    return new EcdsaP256Signer(id, privateKey, { x, y });
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
        P256_IMPORT,
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
      privateKey = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, P256_IMPORT, false, [
        "sign",
      ]);
    } catch (error) {
      if (error instanceof TollwayError) throw error;
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK could not be imported as a P-256 private key",
      );
    }
    const id = keyId ?? bytesToBase64Url(uncompressedPoint(jwk.x, jwk.y));
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
   * Signs a message and returns the IEEE P1363 `r || s` encoding, with `s`
   * in the low half, so each receipt has one valid signature encoding.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.privateKey,
        message as BufferSource,
      ),
    );
    return normaliseLowS(raw);
  }
}

/**
 * The 65-byte uncompressed point `0x04 || x || y`, used as the default key
 * id. WebCrypto cannot export an EC public key as raw bytes from a JWK, so
 * it is assembled from the coordinates.
 */
function uncompressedPoint(x: string, y: string): Uint8Array {
  const xb = base64UrlToBytes(x);
  const yb = base64UrlToBytes(y);
  const out = new Uint8Array(1 + xb.length + yb.length);
  out[0] = 0x04;
  out.set(xb, 1);
  out.set(yb, 1 + xb.length);
  return out;
}

/**
 * Verifies against trusted P-256 public keys by keyId. Any algorithm other
 * than ES256, an unknown key id, a high-S signature or a malformed trusted
 * key returns false; it never throws.
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

  async verify(input: SignatureInput): Promise<boolean> {
    if (input.algorithm !== ECDSA_P256_ALG) return false;
    const coordinates = this.keys.get(input.keyId);
    if (!coordinates) return false;
    let key: CryptoKey;
    try {
      key = await importP256PublicKey(coordinates.x, coordinates.y);
    } catch {
      // A malformed trusted key must not make verification throw.
      return false;
    }
    return verifyEs256(key, input.signature, input.message);
  }
}
