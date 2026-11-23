import { describe, expect, it } from "vitest";
import { TollwayError } from "../errors.js";
import { canonicalBytes } from "./canonical.js";
import {
  derToP1363,
  ECDSA_P256_ALG,
  EcdsaP256Signer,
  EcdsaP256Verifier,
  p1363ToBase64Url,
} from "./ecdsa.js";
import { createKeySetVerifier, type KeySetDocument } from "./key-set.js";
import { Ed25519Signer } from "./signer.js";

/**
 * Issue #169 coverage. The acceptance matrix:
 * - Sign/verify round trip (WebCrypto outputs P1363 already).
 * - Reject high-S signatures (ECDSA malleability window).
 * - DER-to-P1363 happy path, plus strict rejection of trailing bytes,
 *   non-minimal integers, negative integers, oversize scalars.
 * - Cross-algorithm confusion: a P-256 signature cannot be checked
 *   against an Ed25519 record and the other way round.
 * - The key-set verifier accepts `kty: EC, crv: P-256` entries.
 */

describe("EcdsaP256Signer", () => {
  it("round-trips a signed receipt", async () => {
    const signer = await EcdsaP256Signer.generate("p256-a");
    expect(signer.algorithm).toBe(ECDSA_P256_ALG);
    const verifier = EcdsaP256Verifier.forSigner(signer);
    const message = canonicalBytes({ hello: "world", n: 1 });
    const signature = await signer.sign(message);
    expect(signature.length).toBe(64);
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });

  it("publicJwk exports kty/crv/alg/use in the key-set shape", async () => {
    const signer = await EcdsaP256Signer.generate("p256-a");
    const jwk = signer.publicJwk();
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe("p256-a");
    expect(jwk.x.length).toBeGreaterThan(0);
    expect(jwk.y.length).toBeGreaterThan(0);
  });

  it("rejects a JWK with the wrong kty", async () => {
    await expect(
      EcdsaP256Signer.fromJwk({ kty: "OKP", crv: "P-256", d: "x", x: "y", y: "z" }),
    ).rejects.toMatchObject({ code: "invalid-signing-key" });
  });

  it("rejects a JWK whose declared public half does not match its private half", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
      string,
      unknown
    >;
    const tampered = { ...privateJwk, x: "AAAA" };
    await expect(EcdsaP256Signer.fromJwk(tampered)).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });

  it("imports a JWK and produces signatures a verifier accepts", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
      string,
      unknown
    >;
    const signer = await EcdsaP256Signer.fromJwk(privateJwk, "from-jwk");
    const verifier = EcdsaP256Verifier.forSigner(signer);
    const message = canonicalBytes({ a: 1 });
    const signature = await signer.sign(message);
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });
});

describe("EcdsaP256Verifier", () => {
  it("rejects a signature with the wrong algorithm identifier (cross-algorithm confusion)", async () => {
    const signer = await EcdsaP256Signer.generate("p256-a");
    const verifier = EcdsaP256Verifier.forSigner(signer);
    const message = canonicalBytes({ a: 1 });
    const signature = await signer.sign(message);
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: "Ed25519",
    });
    expect(ok).toBe(false);
  });

  it("rejects a high-S malleated signature", async () => {
    // The signer normalises s into the low half, so forging the high-S
    // encoding means computing n - s ourselves.
    const signer = await EcdsaP256Signer.generate("p256-high-s");
    const verifier = EcdsaP256Verifier.forSigner(signer);
    const message = canonicalBytes({ a: 1 });
    const signature = await signer.sign(message);
    const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    let lowS = 0n;
    for (const byte of signature.subarray(32)) lowS = (lowS << 8n) | BigInt(byte);
    const highS = N - lowS;
    const malleated = new Uint8Array(signature);
    let cursor = highS;
    for (let i = 63; i >= 32; i -= 1) {
      malleated[i] = Number(cursor & 0xffn);
      cursor >>= 8n;
    }
    const ok = await verifier.verify({
      message,
      signature: malleated,
      keyId: signer.keyId,
      algorithm: ECDSA_P256_ALG,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature of the wrong length", async () => {
    const signer = await EcdsaP256Signer.generate("p256-len");
    const verifier = EcdsaP256Verifier.forSigner(signer);
    const ok = await verifier.verify({
      message: new Uint8Array([1, 2, 3]),
      signature: new Uint8Array(63),
      keyId: signer.keyId,
      algorithm: ECDSA_P256_ALG,
    });
    expect(ok).toBe(false);
  });
});

describe("derToP1363", () => {
  it("round-trips a valid DER signature into 64 bytes", () => {
    // 0x30 44 02 20 <r 32 bytes> 02 20 <s 32 bytes> - minimum "simple" DER.
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    const p1363 = derToP1363(der);
    expect(p1363.length).toBe(64);
    expect(Array.from(p1363.subarray(0, 32))).toEqual(Array.from(r));
    expect(Array.from(p1363.subarray(32))).toEqual(Array.from(s));
    expect(p1363ToBase64Url(p1363).length).toBeGreaterThan(0);
  });

  it("strips the leading zero added to keep a high-bit scalar positive", () => {
    const r = new Uint8Array(32).fill(0x11);
    const highBitS = new Uint8Array(32);
    highBitS[0] = 0xff;
    // DER INTEGER encodes a high-bit scalar with a leading 0x00.
    const der = new Uint8Array([0x30, 0x45, 0x02, 0x20, ...r, 0x02, 0x21, 0x00, ...highBitS]);
    const p1363 = derToP1363(der);
    expect(p1363[32]).toBe(0xff);
  });

  it("rejects trailing bytes after the SEQUENCE", () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = new Uint8Array([
      0x30,
      0x44,
      0x02,
      0x20,
      ...r,
      0x02,
      0x20,
      ...s,
      0xff, // extra byte
    ]);
    expect(() => derToP1363(der)).toThrow(TollwayError);
  });

  it("rejects non-minimal leading zero in an INTEGER", () => {
    const r = new Uint8Array(32).fill(0x11);
    const nonMinimalS = new Uint8Array(32);
    nonMinimalS[0] = 0x01; // top bit NOT set, so a leading 0x00 is redundant
    const der = new Uint8Array([0x30, 0x45, 0x02, 0x20, ...r, 0x02, 0x21, 0x00, ...nonMinimalS]);
    expect(() => derToP1363(der)).toThrow(/non-minimal/);
  });

  it("rejects a SEQUENCE of a different tag", () => {
    const bad = new Uint8Array([0x31, 0x02, 0x02, 0x00]);
    expect(() => derToP1363(bad)).toThrow(TollwayError);
  });

  it("rejects an oversize scalar", () => {
    // 33-byte INTEGER (would be 0x80-prefixed and 32 bytes after strip, which
    // the parser accepts). Use a truly 33-byte value instead.
    const oversize = new Uint8Array(33).fill(0x01);
    const r = new Uint8Array(32).fill(0x11);
    const der = new Uint8Array([0x30, 0x46, 0x02, 0x20, ...r, 0x02, 0x21, ...oversize]);
    expect(() => derToP1363(der)).toThrow(TollwayError);
  });
});

describe("createKeySetVerifier with ECDSA P-256 keys", () => {
  it("verifies an ES256 receipt signed by a P-256 key in the document", async () => {
    const signer = await EcdsaP256Signer.generate("p256-key");
    const document: KeySetDocument = {
      keys: [{ ...signer.publicJwk(), status: { state: "active" } }],
    };
    const verifier = createKeySetVerifier({ document });
    const message = canonicalBytes({ hello: "p256" });
    const signature = await signer.sign(message);
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });

  it("rejects an ES256 signature against an EdDSA key record (algorithm-bound keys)", async () => {
    const ed = await Ed25519Signer.generate("ed-key");
    const document: KeySetDocument = {
      keys: [{ ...ed.publicJwk(), status: { state: "active" } }],
    };
    const verifier = createKeySetVerifier({ document });
    const message = canonicalBytes({ a: 1 });
    // Make a fake 64-byte "signature"; the point is that the verifier
    // never reaches WebCrypto because algorithm-bound keys reject the
    // mismatch first.
    const fakeSignature = new Uint8Array(64).fill(0x01);
    const ok = await verifier.verify({
      message,
      signature: fakeSignature,
      keyId: ed.keyId,
      algorithm: ECDSA_P256_ALG,
    });
    expect(ok).toBe(false);
  });

  it("rejects an EdDSA receipt against an ES256 key record", async () => {
    const p256 = await EcdsaP256Signer.generate("p256-key");
    const document: KeySetDocument = {
      keys: [{ ...p256.publicJwk(), status: { state: "active" } }],
    };
    const verifier = createKeySetVerifier({ document });
    const message = canonicalBytes({ a: 1 });
    const fakeSignature = new Uint8Array(64).fill(0x01);
    const ok = await verifier.verify({
      message,
      signature: fakeSignature,
      keyId: p256.keyId,
      algorithm: "EdDSA",
    });
    expect(ok).toBe(false);
  });
});
