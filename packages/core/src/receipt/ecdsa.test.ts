import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import { canonicalBytes } from "./canonical.js";
import {
  derToP1363,
  ECDSA_P256_ALG,
  EcdsaP256Signer,
  EcdsaP256Verifier,
  normaliseLowS,
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
    // 0x30 44 02 20 <r 32 bytes> 02 20 <s 32 bytes>: the simplest DER form.
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

const P256_N_HEX = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function derSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const integer = (scalar: Uint8Array) => {
    const body = (scalar[0] ?? 0) >= 0x80 ? [0x00, ...scalar] : [...scalar];
    return [0x02, body.length, ...body];
  };
  const content = [...integer(r), ...integer(s)];
  return new Uint8Array([0x30, content.length, ...content]);
}

describe("derToP1363 strictness", () => {
  const r = new Uint8Array(32).fill(0x11);
  const s = new Uint8Array(32).fill(0x22);

  it("throws invalid-signature-encoding, not invalid-signing-key", () => {
    expect(() => derToP1363(new Uint8Array([0x31]))).toThrow(
      expect.objectContaining({ code: "invalid-signature-encoding" }),
    );
  });

  it("rejects a long-form length for a value below 128", () => {
    const der = new Uint8Array([0x30, 0x81, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    expect(() => derToP1363(der)).toThrow(/non-minimal length/);
  });

  it("rejects a long-form length with a leading zero byte", () => {
    const der = new Uint8Array([0x30, 0x82, 0x00, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    expect(() => derToP1363(der)).toThrow(/non-minimal length/);
  });

  it("rejects the indefinite length form", () => {
    const der = new Uint8Array([0x30, 0x80, 0x02, 0x20, ...r, 0x02, 0x20, ...s, 0x00, 0x00]);
    expect(() => derToP1363(der)).toThrow(/invalid length encoding/);
  });

  it("rejects a zero r or s", () => {
    expect(() => derToP1363(derSignature(new Uint8Array([0]), s))).toThrow(/r is zero/);
    expect(() => derToP1363(derSignature(r, new Uint8Array([0])))).toThrow(/s is zero/);
  });

  it("rejects r or s equal to or above the P-256 order", () => {
    const n = hexBytes(P256_N_HEX);
    const aboveN = hexBytes(P256_N_HEX.replace(/1$/, "2"));
    expect(() => derToP1363(derSignature(n, s))).toThrow(/r is not below the P-256 order/);
    expect(() => derToP1363(derSignature(r, aboveN))).toThrow(/s is not below the P-256 order/);
  });

  it("accepts a 31-byte r and left-pads it", () => {
    const short = new Uint8Array(31).fill(0x33);
    const p1363 = derToP1363(derSignature(short, s));
    expect(p1363[0]).toBe(0);
    expect(Array.from(p1363.subarray(1, 32))).toEqual(Array.from(short));
  });
});

describe("normaliseLowS", () => {
  it("moves a high s into the low half and leaves a low s alone", () => {
    const n = BigInt(`0x${P256_N_HEX}`);
    const high = new Uint8Array(64);
    high.set(hexBytes((n - 1n).toString(16).padStart(64, "0")), 32);
    const low = normaliseLowS(high);
    expect(Array.from(low.subarray(32))).toEqual(Array.from(hexBytes("01".padStart(64, "0"))));
    expect(normaliseLowS(low)).toBe(low);
  });
});

describe("EcdsaP256Signer.fromPkcs8", () => {
  async function exportedPkcs8(): Promise<Uint8Array> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  }

  it("imports PKCS#8 bytes or base64url, and its signatures verify", async () => {
    const der = await exportedPkcs8();
    for (const encoded of [der, bytesToBase64Url(der)]) {
      const signer = await EcdsaP256Signer.fromPkcs8(encoded, "kms-key");
      expect(signer.keyId).toBe("kms-key");
      const message = canonicalBytes({ imported: true });
      const ok = await EcdsaP256Verifier.forSigner(signer).verify({
        message,
        signature: await signer.sign(message),
        keyId: signer.keyId,
        algorithm: signer.algorithm,
      });
      expect(ok).toBe(true);
    }
  });

  it("refuses an Ed25519 PKCS#8 key and a value that is not base64url", async () => {
    const ed = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const edPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", ed.privateKey));
    await expect(EcdsaP256Signer.fromPkcs8(edPkcs8)).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
    await expect(EcdsaP256Signer.fromPkcs8("not base64url!")).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });
});

describe("ES256 interop with an independent implementation (node:crypto)", () => {
  // RFC 6979 appendix A.2.5: the P-256 test key, and the deterministic
  // SHA-256 signature over the ASCII message "sample". The published s is
  // in the high half, so Tollway's low-S rule must refuse it as is and
  // accept it once normalised.
  const RFC6979 = {
    x: "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6",
    y: "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299",
    r: "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716",
    s: "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8",
  };

  it("verifies the RFC 6979 A.2.5 signature after low-S normalisation, and refuses its high-S form", async () => {
    const verifier = new EcdsaP256Verifier({
      rfc6979: {
        x: bytesToBase64Url(hexBytes(RFC6979.x.toLowerCase())),
        y: bytesToBase64Url(hexBytes(RFC6979.y.toLowerCase())),
      },
    });
    const message = new TextEncoder().encode("sample");
    const published = hexBytes(`${RFC6979.r}${RFC6979.s}`.toLowerCase());
    const input = { message, keyId: "rfc6979", algorithm: "ES256" };
    expect(await verifier.verify({ ...input, signature: published })).toBe(false);
    expect(await verifier.verify({ ...input, signature: normaliseLowS(published) })).toBe(true);
  });

  it("accepts a DER signature node:crypto produced, and node:crypto accepts Tollway's", async () => {
    const { generateKeyPairSync, createPublicKey, sign, verify } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const verifier = new EcdsaP256Verifier({
      node: { x: String(jwk.x), y: String(jwk.y) },
    });
    const message = canonicalBytes({ from: "node" });
    const der = sign("sha256", message, privateKey);
    const p1363 = normaliseLowS(derToP1363(new Uint8Array(der)));
    expect(
      await verifier.verify({ message, signature: p1363, keyId: "node", algorithm: "ES256" }),
    ).toBe(true);

    const signer = await EcdsaP256Signer.generate("tollway");
    const ours = await signer.sign(message);
    const theirKey = createPublicKey({ key: signer.publicJwk(), format: "jwk" });
    expect(verify("sha256", message, { key: theirKey, dsaEncoding: "ieee-p1363" }, ours)).toBe(
      true,
    );
  });
});
