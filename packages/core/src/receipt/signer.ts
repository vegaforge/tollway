import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import {
  canonicalAlgorithm,
  ED25519_ALGORITHM,
  EDDSA_ALGORITHM,
  importEd25519PublicKey,
  verifyEd25519,
} from "./algorithms.js";

/**
 * Signing sits behind an interface so the key can live wherever a deployment
 * needs it: in process, a KMS, an HSM. Ed25519 over WebCrypto is the default
 * and runs in both Node and edge runtimes.
 */

export interface ReceiptSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** What a verifier is asked to check: the signed bytes and the signature block. */
export type SignatureInput = {
  message: Uint8Array;
  signature: Uint8Array;
  keyId: string;
  algorithm: string;
};

/**
 * The outcome of {@link ReceiptVerifier.check}: valid, or invalid with a
 * reason a caller can show, such as "key k1 is revoked".
 */
export type SignatureCheck = { valid: true } | { valid: false; reason: string };

/**
 * Checks a receipt signature against keys the caller trusts. Implementations
 * return false, rather than throw, for an unknown key or algorithm.
 *
 * A verifier that can say why a signature fails also implements `check`.
 * {@link verifyReceipt} prefers it, so a revoked key, a retired key and a
 * forged signature come back with different reasons.
 */
export interface ReceiptVerifier {
  verify(input: SignatureInput): Promise<boolean>;
  check?(input: SignatureInput): Promise<SignatureCheck>;
}

const ED25519 = ED25519_ALGORITHM;

/** An Ed25519 private key is a 32-byte seed. */
const ED25519_SEED_BYTES = 32;

/**
 * The fixed DER header of a PKCS#8 document that wraps an Ed25519 seed
 * (RFC 8410): a version, the Ed25519 algorithm OID 1.3.101.112, and an octet
 * string of 32 bytes. WebCrypto only imports Ed25519 private keys as PKCS#8
 * or JWK, so a raw seed is wrapped in this header before import.
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const ED25519_PKCS8_BYTES = ED25519_PKCS8_PREFIX.length + ED25519_SEED_BYTES;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Turns a stored key into PKCS#8 bytes. Error messages describe the problem
 * but never include the key, so a misconfigured deployment cannot leak it
 * into logs.
 */
function toPkcs8(encodedKey: string): Uint8Array {
  const text = encodedKey.trim();
  if (!BASE64URL.test(text)) {
    throw new TollwayError(
      "invalid-signing-key",
      "receipt signing key must be base64url (A-Z, a-z, 0-9, - and _, no padding)",
    );
  }
  const bytes = base64UrlToBytes(text);
  if (bytes.length === ED25519_SEED_BYTES) {
    const pkcs8 = new Uint8Array(ED25519_PKCS8_BYTES);
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(bytes, ED25519_PKCS8_PREFIX.length);
    return pkcs8;
  }
  if (bytes.length === ED25519_PKCS8_BYTES) {
    const header = bytes.subarray(0, ED25519_PKCS8_PREFIX.length);
    if (!header.every((byte, index) => byte === ED25519_PKCS8_PREFIX[index])) {
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing key is 48 bytes but is not an Ed25519 PKCS#8 private key",
      );
    }
    return bytes;
  }
  throw new TollwayError(
    "invalid-signing-key",
    `receipt signing key must decode to a 32-byte Ed25519 seed or a 48-byte PKCS#8 document, got ${bytes.length} bytes`,
  );
}

export class Ed25519Signer implements ReceiptSigner {
  readonly algorithm = ED25519;
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  private readonly privateKey: CryptoKey;

  private constructor(keyId: string, publicKey: Uint8Array, privateKey: CryptoKey) {
    this.keyId = keyId;
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }

  /**
   * Generates a keypair. keyId defaults to the base64url public key; pass a
   * name if you rotate keys and want stable ids.
   */
  static async generate(keyId?: string): Promise<Ed25519Signer> {
    const pair = (await crypto.subtle.generateKey(ED25519, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return new Ed25519Signer(keyId ?? bytesToBase64Url(publicKey), publicKey, pair.privateKey);
  }

  /**
   * Loads a persisted Ed25519 private key, so every instance of a service
   * signs with the same key and receipts verify against one published public
   * key. `generate()` cannot do that: each cold start would get a new key.
   *
   * `encodedKey` is base64url without padding, holding either the raw 32-byte
   * seed or the 48-byte PKCS#8 DER document that
   * `crypto.subtle.exportKey("pkcs8", ...)` and `openssl genpkey -algorithm
   * ed25519 -outform DER` produce. WebCrypto only, so it runs on Node and
   * edge runtimes alike.
   *
   * keyId defaults to the base64url public key, which is stable for a given
   * private key.
   *
   * @throws TollwayError with code `invalid-signing-key` when the value is
   * not base64url, has the wrong length, or is not an Ed25519 key. The
   * message never contains the key.
   */
  static async fromPrivateKey(encodedKey: string, keyId?: string): Promise<Ed25519Signer> {
    const pkcs8 = toPkcs8(encodedKey);
    // The key is imported extractable once, only to read the public half from
    // its JWK form, then imported again without extraction for signing.
    let publicKey: Uint8Array;
    let privateKey: CryptoKey;
    try {
      const extractable = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8 as BufferSource,
        ED25519,
        true,
        ["sign"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", extractable);
      if (typeof jwk.x !== "string") {
        throw new TollwayError("invalid-signing-key", "receipt signing key has no public half");
      }
      publicKey = base64UrlToBytes(jwk.x);
      privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, ED25519, false, [
        "sign",
      ]);
    } catch (error) {
      if (error instanceof TollwayError) {
        throw error;
      }
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing key could not be imported as an Ed25519 private key",
      );
    }
    return new Ed25519Signer(keyId ?? bytesToBase64Url(publicKey), publicKey, privateKey);
  }

  /**
   * Loads a persisted Ed25519 private key from a JWK (RFC 7517 + RFC 8037):
   * `{ kty: "OKP", crv: "Ed25519", d, x, ... }`. The `d` field holds the
   * 32-byte seed base64url-encoded; `x` holds the public half.
   *
   * JWKs sit next to the key-set document format (#167) and most KMSes can
   * export private keys as JWKs too, so this is the import path a service
   * uses when its key material already travels as JWK rather than as
   * PKCS#8.
   *
   * @throws TollwayError("invalid-signing-key", ...) when the JWK is
   *   missing `d`, carries the wrong `kty` or `crv`, or when the material
   *   is not a valid Ed25519 key. The message never contains the private
   *   half.
   */
  static async fromJwk(jwk: Record<string, unknown>, keyId?: string): Promise<Ed25519Signer> {
    if (jwk.kty !== "OKP") {
      throw new TollwayError(
        "invalid-signing-key",
        `receipt signing JWK has kty ${String(jwk.kty)}, expected "OKP"`,
      );
    }
    if (jwk.crv !== ED25519) {
      throw new TollwayError(
        "invalid-signing-key",
        `receipt signing JWK has crv ${String(jwk.crv)}, expected "Ed25519"`,
      );
    }
    if (typeof jwk.d !== "string" || jwk.d.length === 0) {
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK has no private half (`d` is missing)",
      );
    }
    if (typeof jwk.x !== "string" || jwk.x.length === 0) {
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK has no public half (`x` is missing)",
      );
    }
    let publicKey: Uint8Array;
    let privateKey: CryptoKey;
    try {
      // Import once extractable so we can confirm the public half matches
      // what the JWK declared; then import again non-extractable for
      // signing, so the private material cannot be exported later.
      const extractable = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, ED25519, true, [
        "sign",
      ]);
      const exported = await crypto.subtle.exportKey("jwk", extractable);
      if (typeof exported.x !== "string") {
        throw new TollwayError("invalid-signing-key", "receipt signing JWK has no public half");
      }
      publicKey = base64UrlToBytes(exported.x);
      if (exported.x !== jwk.x) {
        throw new TollwayError(
          "invalid-signing-key",
          "receipt signing JWK private half does not match its stated public half",
        );
      }
      privateKey = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, ED25519, false, [
        "sign",
      ]);
    } catch (error) {
      if (error instanceof TollwayError) throw error;
      throw new TollwayError(
        "invalid-signing-key",
        "receipt signing JWK could not be imported as an Ed25519 private key",
      );
    }
    return new Ed25519Signer(keyId ?? bytesToBase64Url(publicKey), publicKey, privateKey);
  }

  /**
   * The signer's public half as a JWK (RFC 7517 + RFC 8037). The JWK
   * carries `kid` and `alg` so it slots directly into a key-set document
   * without further work. The private half never leaves the signer.
   */
  publicJwk(): PublicJwk {
    return {
      kty: "OKP",
      crv: ED25519,
      x: bytesToBase64Url(this.publicKey),
      kid: this.keyId,
      alg: EDDSA_ALGORITHM,
      use: "sig",
    };
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign(ED25519, this.privateKey, message as BufferSource),
    );
  }
}

/**
 * The public half of an Ed25519 key in JWK form. The `kid` and `alg`
 * fields are what a key-set document needs on top of the raw material.
 */
export type PublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
};

/**
 * Verifies against a set of trusted public keys by keyId. An unknown key, a
 * different algorithm or a malformed trusted key returns false rather than
 * throwing. `Ed25519` and its JOSE name `EdDSA` are the same algorithm.
 */
export class Ed25519Verifier implements ReceiptVerifier {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(publicKeys: Record<string, Uint8Array | string>) {
    for (const [keyId, key] of Object.entries(publicKeys)) {
      this.keys.set(keyId, typeof key === "string" ? base64UrlToBytes(key) : key);
    }
  }

  static forSigner(signer: Ed25519Signer): Ed25519Verifier {
    return new Ed25519Verifier({ [signer.keyId]: signer.publicKey });
  }

  async verify(input: SignatureInput): Promise<boolean> {
    if (canonicalAlgorithm(input.algorithm) !== EDDSA_ALGORITHM) {
      return false;
    }
    const raw = this.keys.get(input.keyId);
    if (!raw) {
      return false;
    }
    let key: CryptoKey;
    try {
      key = await importEd25519PublicKey(raw);
    } catch {
      // A malformed trusted key is a configuration problem, but a verifier
      // must not throw on a receipt, so the receipt simply does not verify.
      return false;
    }
    return verifyEd25519(key, input.signature, input.message);
  }
}
