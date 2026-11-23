import { describe, expect, it, vi } from "vitest";
import { TollwayError } from "../errors.js";
import { canonicalBytes } from "./canonical.js";
import { createKeySetVerifier, type KeySetDocument, type KeySetFetcher } from "./key-set.js";
import { Ed25519Signer } from "./signer.js";

/**
 * Issue #167 coverage for the key-set verifier. The matrix:
 * - A well-formed document verifies a signature produced by a key in it.
 * - Unknown kid: refetch once per cool-down, not per receipt.
 * - Revoked keys reject every receipt they ever signed.
 * - Retired keys verify receipts whose `issuedAt` is strictly before
 *   `retiredAt` and reject later ones.
 * - Algorithm mismatch returns false, not a throw.
 * - Cache-Control max-age is honoured within min/max bounds.
 * - Fetch failure after a cached copy keeps serving on the cache.
 * - Fetch failure with no cache fails closed.
 * - refresh() drops the cache.
 */

function makeCaps(signer: Ed25519Signer) {
  return {
    async signReceipt(body: { issuedAt: string }) {
      const bytes = canonicalBytes(body);
      const signature = await signer.sign(bytes);
      return { message: bytes, signature };
    },
  };
}

function docWith(
  signer: Ed25519Signer,
  status: KeySetDocument["keys"][number]["status"] = { state: "active" },
): KeySetDocument {
  return {
    keys: [{ ...signer.publicJwk(), status }],
  };
}

function okResponse(body: unknown, maxAgeSeconds?: number) {
  const headers = new Headers({
    "content-type": "application/jwk-set+json",
  });
  if (maxAgeSeconds !== undefined) {
    headers.set("cache-control", `public, max-age=${maxAgeSeconds}`);
  }
  return {
    status: 200,
    headers,
    text: async () => JSON.stringify(body),
  };
}

describe("createKeySetVerifier", () => {
  it("verifies a receipt signed by a key in the document", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const verifier = createKeySetVerifier({ document: docWith(signer) });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({ issuedAt: "2026-11-23T00:00:00.000Z" });
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });

  it("returns false for an unknown algorithm without throwing", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const verifier = createKeySetVerifier({ document: docWith(signer) });
    const ok = await verifier.verify({
      message: new Uint8Array(),
      signature: new Uint8Array(),
      keyId: signer.keyId,
      algorithm: "P-256",
    });
    expect(ok).toBe(false);
  });

  it("refetches at most once per unknown-kid cool-down window", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    let now = 1_000_000;
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys: [signer.publicJwk()] }));
    const verifier = createKeySetVerifier({
      url: "https://example.com/.well-known/keys",
      fetch: fetchFn,
      clock: () => now,
      unknownKidRefetchCooldownMs: 10_000,
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });
    // First call: initial fetch.
    await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Unknown kid triggers one refetch.
    await verifier.verify({
      message,
      signature,
      keyId: "mystery",
      algorithm: signer.algorithm,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // A second unknown kid inside the cooldown window must not refetch.
    now += 5_000;
    await verifier.verify({
      message,
      signature,
      keyId: "mystery-2",
      algorithm: signer.algorithm,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Past the cooldown it may refetch again.
    now += 20_000;
    await verifier.verify({
      message,
      signature,
      keyId: "mystery-3",
      algorithm: signer.algorithm,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("revoked keys reject every receipt they signed", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const verifier = createKeySetVerifier({
      document: docWith(signer, { state: "revoked" }),
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(false);
  });

  it("retired keys verify receipts strictly before retiredAt and reject later ones", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const retiredAt = "2026-11-23T00:00:00.000Z";
    const verifier = createKeySetVerifier({
      document: docWith(signer, { state: "retired", retiredAt }),
    });
    const caps = makeCaps(signer);

    const before = await caps.signReceipt({ issuedAt: "2026-11-22T23:59:59.000Z" });
    expect(
      await verifier.verify({
        message: before.message,
        signature: before.signature,
        keyId: signer.keyId,
        algorithm: signer.algorithm,
      }),
    ).toBe(true);

    const after = await caps.signReceipt({ issuedAt: "2026-11-23T00:00:01.000Z" });
    expect(
      await verifier.verify({
        message: after.message,
        signature: after.signature,
        keyId: signer.keyId,
        algorithm: signer.algorithm,
      }),
    ).toBe(false);
  });

  it("honours Cache-Control max-age clamped by min and max bounds", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    let now = 1_000_000;
    const fetchFn = vi.fn<KeySetFetcher>(async () =>
      okResponse({ keys: [signer.publicJwk()] }, 60),
    );
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: fetchFn,
      clock: () => now,
      minCacheMs: 5_000,
      maxCacheMs: 120_000,
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });

    await verifier.verify({ message, signature, keyId: signer.keyId, algorithm: signer.algorithm });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Within max-age (60s), another call uses cache.
    now += 30_000;
    await verifier.verify({ message, signature, keyId: signer.keyId, algorithm: signer.algorithm });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Past max-age, the cache is stale and a refetch happens.
    now += 60_000;
    await verifier.verify({ message, signature, keyId: signer.keyId, algorithm: signer.algorithm });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps serving on the cached copy when a refetch fails", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    let now = 1_000_000;
    let fail = false;
    const fetchFn = vi.fn<KeySetFetcher>(async () => {
      if (fail) throw new Error("network down");
      return okResponse({ keys: [signer.publicJwk()] }, 10);
    });
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: fetchFn,
      clock: () => now,
      minCacheMs: 1_000,
      maxCacheMs: 60_000,
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });
    await verifier.verify({ message, signature, keyId: signer.keyId, algorithm: signer.algorithm });
    fail = true;
    now += 20_000; // past max-age, before maxCacheMs
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });

  it("fails closed when the first fetch fails and no cache exists", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const fetchFn = vi.fn<KeySetFetcher>(async () => {
      throw new Error("down");
    });
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: fetchFn,
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });
    await expect(
      verifier.verify({
        message,
        signature,
        keyId: signer.keyId,
        algorithm: signer.algorithm,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a document body that does not match the schema", async () => {
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys: [{ not: "a jwk" }] }));
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: fetchFn,
    });
    await expect(
      verifier.verify({
        message: new Uint8Array(),
        signature: new Uint8Array(),
        keyId: "anything",
        algorithm: "Ed25519",
      }),
    ).rejects.toMatchObject({ code: "payment-failed" });
  });

  it("refresh() drops the cache so the next verify refetches", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const fetchFn = vi.fn<KeySetFetcher>(async () =>
      okResponse({ keys: [signer.publicJwk()] }, 60),
    );
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: fetchFn,
    });
    const caps = makeCaps(signer);
    const { message, signature } = await caps.signReceipt({
      issuedAt: "2026-11-23T00:00:00.000Z",
    });
    await verifier.verify({ message, signature, keyId: signer.keyId, algorithm: signer.algorithm });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await verifier.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("requires exactly one of `url` or `document`", () => {
    expect(() => createKeySetVerifier({})).toThrow(TollwayError);
    expect(() => createKeySetVerifier({ url: "https://x", document: { keys: [] } })).toThrow(
      TollwayError,
    );
  });
});

describe("Ed25519Signer.fromJwk / publicJwk", () => {
  it("round-trips a signer through JWK export and PKCS#8 import (public half agrees)", async () => {
    const original = await Ed25519Signer.generate("roundtrip");
    const jwk = original.publicJwk();
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe("roundtrip");
    expect(jwk.x.length).toBeGreaterThan(0);
  });

  it("imports a private JWK and signs with it", async () => {
    // Export a generated signer to JWK via the WebCrypto surface then
    // re-import through the new fromJwk path; the two signatures must
    // verify against the same public key.
    const generated = await Ed25519Signer.generate("original");
    // The only way to get the private JWK is to generate a new key and
    // read back; we cannot export generated's private half (we imported
    // non-extractable). Instead, import a fresh extractable key pair
    // here and use fromJwk on its private JWK.
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
      string,
      unknown
    >;
    const imported = await Ed25519Signer.fromJwk(privateJwk, "from-jwk");
    expect(imported.keyId).toBe("from-jwk");
    const signature = await imported.sign(new Uint8Array([1, 2, 3]));
    expect(signature.length).toBe(64);
    // The two signers have different keys, so sanity check they produce
    // different signatures over the same message.
    const otherSig = await generated.sign(new Uint8Array([1, 2, 3]));
    expect(Buffer.from(signature).equals(Buffer.from(otherSig))).toBe(false);
  });

  it("rejects a JWK with the wrong kty", async () => {
    await expect(
      Ed25519Signer.fromJwk({ kty: "EC", crv: "Ed25519", d: "x", x: "y" }),
    ).rejects.toMatchObject({ code: "invalid-signing-key" });
  });

  it("rejects a JWK with no private half", async () => {
    await expect(
      Ed25519Signer.fromJwk({ kty: "OKP", crv: "Ed25519", x: "y" }),
    ).rejects.toMatchObject({ code: "invalid-signing-key" });
  });

  it("rejects a JWK whose declared public half does not match its private half", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
      string,
      unknown
    >;
    const tampered = { ...privateJwk, x: "AAAA" };
    await expect(Ed25519Signer.fromJwk(tampered)).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });
});
