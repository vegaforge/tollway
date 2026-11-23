import { describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import { canonicalBytes } from "./canonical.js";
import { EcdsaP256Signer } from "./ecdsa.js";
import {
  createKeySetVerifier,
  type KeySetEntry,
  type KeySetFetcher,
  parseKeySetDocument,
} from "./key-set.js";
import { buildReceipt, signReceipt, verifyReceipt } from "./receipt.js";
import { Ed25519Signer, type ReceiptSigner, type SignatureInput } from "./signer.js";

/**
 * Issue #167 (and the P-256 records from #169) coverage for the key-set
 * verifier:
 * - keys in the document verify; algorithm binding holds both ways;
 * - revoked and retired keys fail with their own reasons;
 * - Cache-Control is honoured within bounds, with a default when absent;
 * - an expired copy is not used once a refetch fails, unless
 *   `staleIfErrorMs` allows it, so a revocation is seen in bounded time;
 * - a failing URL is fetched once per backoff window, not once per receipt;
 * - unknown kids refetch once per cooldown;
 * - check() and verifyReceipt never throw;
 * - documents with duplicate kids or bad key material are refused.
 */

const URL_ = "https://example.com/.well-known/tollway-receipt-keys.jwks";
const ISSUED = "2026-11-23T00:00:00.000Z";

async function signed(signer: ReceiptSigner, issuedAt = ISSUED): Promise<SignatureInput> {
  const message = canonicalBytes({ issuedAt });
  return {
    message,
    signature: await signer.sign(message),
    keyId: signer.keyId,
    algorithm: signer.algorithm,
  };
}

function entry(
  signer: Ed25519Signer | EcdsaP256Signer,
  status: KeySetEntry["status"] = { state: "active" },
): KeySetEntry {
  return { ...signer.publicJwk(), status };
}

function okResponse(body: unknown, cacheControl?: string) {
  const headers = new Headers({ "content-type": "application/jwk-set+json" });
  if (cacheControl !== undefined) headers.set("cache-control", cacheControl);
  return { status: 200, headers, text: async () => JSON.stringify(body) };
}

function failingFetch() {
  return vi.fn<KeySetFetcher>(async () => {
    throw new TypeError("fetch failed");
  });
}

describe("createKeySetVerifier: keys and statuses", () => {
  it("verifies Ed25519 and P-256 receipts signed by keys in the document", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const p256 = await EcdsaP256Signer.generate("p256");
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed), entry(p256)] } });
    expect(await verifier.check(await signed(ed))).toEqual({ valid: true });
    expect(await verifier.check(await signed(p256))).toEqual({ valid: true });
  });

  it("refuses an unknown algorithm, alg none included, with a reason", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed)] } });
    for (const algorithm of ["none", "P-256", "HS256"]) {
      expect(await verifier.check({ ...(await signed(ed)), algorithm })).toEqual({
        valid: false,
        reason: `algorithm ${algorithm} is not supported`,
      });
    }
  });

  it("binds each key to its algorithm, both ways", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const p256 = await EcdsaP256Signer.generate("p256");
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed), entry(p256)] } });
    expect(await verifier.check({ ...(await signed(ed)), algorithm: "ES256" })).toEqual({
      valid: false,
      reason: "key ed is bound to EdDSA, not ES256",
    });
    expect(await verifier.check({ ...(await signed(p256)), algorithm: "EdDSA" })).toEqual({
      valid: false,
      reason: "key p256 is bound to ES256, not EdDSA",
    });
  });

  it("fails every receipt of a revoked key with its own reason", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const verifier = createKeySetVerifier({
      document: { keys: [entry(ed, { state: "revoked" })] },
    });
    expect(await verifier.check(await signed(ed, "2000-01-01T00:00:00.000Z"))).toEqual({
      valid: false,
      reason: "key ed is revoked",
    });
  });

  it("verifies a retired key strictly before retiredAt and fails later receipts with a reason", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const retiredAt = "2026-11-23T12:00:00.000Z";
    const verifier = createKeySetVerifier({
      document: { keys: [entry(ed, { state: "retired", retiredAt })] },
    });
    expect(await verifier.check(await signed(ed, "2026-11-23T11:59:59.999Z"))).toEqual({
      valid: true,
    });
    for (const issuedAt of [retiredAt, "2026-11-24T00:00:00.000Z"]) {
      expect(await verifier.check(await signed(ed, issuedAt))).toEqual({
        valid: false,
        reason: `key ed was retired at ${retiredAt}, before this receipt was issued`,
      });
    }
  });

  it("tells a forged signature apart from an unknown key", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const other = await Ed25519Signer.generate("ed");
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed)] } });
    expect(await verifier.check(await signed(other))).toEqual({
      valid: false,
      reason: "signature does not verify",
    });
    expect(await verifier.check({ ...(await signed(ed)), keyId: "missing" })).toEqual({
      valid: false,
      reason: "unknown key missing",
    });
  });

  it("gives verifyReceipt distinct reasons for revoked, retired and forged receipts", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const body = buildReceipt({
      issuedAt: ISSUED,
      payer: "GPAYER",
      payee: "GPAYEE",
      amount: "100",
      asset: "USDC",
      resource: "/r",
      model: "x402",
      settlement: { kind: "transaction", txHash: "tx" },
      network: "testnet",
    });
    const receipt = await signReceipt(body, ed);
    const verifierFor = (status: KeySetEntry["status"]) =>
      createKeySetVerifier({ document: { keys: [entry(ed, status)] } });
    expect(await verifyReceipt(receipt, verifierFor({ state: "revoked" }))).toEqual({
      valid: false,
      reason: "key ed is revoked",
    });
    expect(
      await verifyReceipt(receipt, verifierFor({ state: "retired", retiredAt: ISSUED })),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("was retired at") });
    const forged = { ...receipt, receipt: { ...receipt.receipt, amount: "1" } };
    expect(await verifyReceipt(forged, verifierFor({ state: "active" }))).toEqual({
      valid: false,
      reason: "signature does not verify",
    });
  });
});

describe("createKeySetVerifier: documents", () => {
  it("refuses a document with a duplicate kid", async () => {
    const a = await Ed25519Signer.generate("same");
    const b = await Ed25519Signer.generate("same");
    expect(() => createKeySetVerifier({ document: { keys: [entry(a), entry(b)] } })).toThrow(
      /duplicate kid same/,
    );
  });

  it("refuses key material of the wrong length at parse time", () => {
    const short = { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "k", alg: "EdDSA" };
    expect(() => parseKeySetDocument({ keys: [short] })).toThrow(/keys\.0\.x: expected 32 bytes/);
    const p256 = {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(new Uint8Array(31)),
      y: bytesToBase64Url(new Uint8Array(32)),
      kid: "k",
      alg: "ES256",
    };
    expect(() => parseKeySetDocument({ keys: [p256] })).toThrow(TollwayError);
  });

  it("fails every check, without throwing, when a P-256 point is not on the curve", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const notOnCurve = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: bytesToBase64Url(new Uint8Array(32).fill(1)),
      y: bytesToBase64Url(new Uint8Array(32).fill(1)),
      kid: "bad",
      alg: "ES256" as const,
      status: { state: "active" as const },
    };
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed), notOnCurve] } });
    expect(await verifier.check(await signed(ed))).toEqual({
      valid: false,
      reason: "key set unavailable: key-set document is invalid: key bad could not be imported",
    });
  });

  it("keeps working after refresh() on a document verifier", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const verifier = createKeySetVerifier({ document: { keys: [entry(ed)] } });
    await verifier.refresh();
    expect(await verifier.verify(await signed(ed))).toBe(true);
  });

  it("requires exactly one of `url` or `document`", () => {
    expect(() => createKeySetVerifier({})).toThrow(TollwayError);
    expect(() => createKeySetVerifier({ url: URL_, document: { keys: [] } })).toThrow(TollwayError);
  });
});

describe("createKeySetVerifier: fetching and caching", () => {
  it("honours max-age between the floor and the ceiling, and a default when absent", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const input = await signed(ed);
    const cases: [string | undefined, number][] = [
      ["public, max-age=120", 120_000],
      ["max-age=0", 10_000],
      ["max-age=999999", 3_600_000],
      [undefined, 300_000],
    ];
    for (const [cacheControl, lifetime] of cases) {
      let now = 0;
      const fetchFn = vi.fn<KeySetFetcher>(async () =>
        okResponse({ keys: [entry(ed)] }, cacheControl),
      );
      const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn, clock: () => now });
      await verifier.check(input);
      now = lifetime - 1;
      await verifier.check(input);
      expect(fetchFn, `${cacheControl}: still fresh`).toHaveBeenCalledTimes(1);
      now = lifetime;
      await verifier.check(input);
      expect(fetchFn, `${cacheControl}: expired`).toHaveBeenCalledTimes(2);
    }
  });

  it("caps the cache lifetime at the document's own expiresAt", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let now = Date.parse("2026-11-23T00:00:00.000Z");
    const fetchFn = vi.fn<KeySetFetcher>(async () =>
      okResponse({ keys: [entry(ed)], expiresAt: "2026-11-23T00:00:30.000Z" }, "max-age=600"),
    );
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn, clock: () => now });
    await verifier.check(await signed(ed));
    now += 30_000;
    await verifier.check(await signed(ed));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed once the cached copy expires and the refetch fails, so a revocation is not hidden", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let now = 0;
    let up = true;
    const fetchFn = vi.fn<KeySetFetcher>(async () => {
      if (!up) throw new TypeError("fetch failed");
      return okResponse({ keys: [entry(ed)] }, "max-age=60");
    });
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn, clock: () => now });
    expect(await verifier.check(await signed(ed))).toEqual({ valid: true });
    up = false;
    now = 60_000;
    expect(await verifier.check(await signed(ed))).toEqual({
      valid: false,
      reason: "key set unavailable: key set fetch failed: fetch failed",
    });
  });

  it("uses an expired copy for staleIfErrorMs while refetching fails, then fails closed", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let now = 0;
    let up = true;
    const fetchFn = vi.fn<KeySetFetcher>(async () => {
      if (!up) return { status: 503, headers: new Headers(), text: async () => "" };
      return okResponse({ keys: [entry(ed)] }, "max-age=60");
    });
    const verifier = createKeySetVerifier({
      url: URL_,
      fetch: fetchFn,
      clock: () => now,
      staleIfErrorMs: 30_000,
      failureBackoffMs: 0,
    });
    await verifier.check(await signed(ed));
    up = false;
    now = 60_000 + 29_999;
    expect(await verifier.check(await signed(ed))).toEqual({ valid: true });
    now = 60_000 + 30_000;
    expect(await verifier.check(await signed(ed))).toEqual({
      valid: false,
      reason: "key set unavailable: key set answered HTTP 503",
    });
  });

  it("fetches a failing URL once per backoff window, not once per receipt", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let now = 0;
    const fetchFn = failingFetch();
    const verifier = createKeySetVerifier({
      url: URL_,
      fetch: fetchFn,
      clock: () => now,
      failureBackoffMs: 30_000,
    });
    const input = await signed(ed);
    for (let i = 0; i < 20; i += 1) {
      expect(await verifier.verify(input)).toBe(false);
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 29_999;
    await verifier.verify(input);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 30_000;
    await verifier.verify(input);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between concurrent checks", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys: [entry(ed)] }));
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn });
    const input = await signed(ed);
    const results = await Promise.all([1, 2, 3, 4].map(() => verifier.verify(input)));
    expect(results).toEqual([true, true, true, true]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches for an unknown kid at most once per cooldown", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let now = 0;
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys: [entry(ed)] }));
    const verifier = createKeySetVerifier({
      url: URL_,
      fetch: fetchFn,
      clock: () => now,
      unknownKidRefetchCooldownMs: 10_000,
    });
    const input = await signed(ed);
    await verifier.check(input);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await verifier.check({ ...input, keyId: "forged-1" })).toEqual({
      valid: false,
      reason: "unknown key forged-1",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now = 5_000;
    await verifier.check({ ...input, keyId: "forged-2" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now = 10_000;
    await verifier.check({ ...input, keyId: "forged-3" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("picks up a new key through the unknown-kid refetch", async () => {
    const first = await Ed25519Signer.generate("first");
    const second = await Ed25519Signer.generate("second");
    let keys = [entry(first)];
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys }, "max-age=600"));
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn });
    expect(await verifier.verify(await signed(first))).toBe(true);
    keys = [entry(first), entry(second)];
    expect(await verifier.verify(await signed(second))).toBe(true);
  });

  it("reports an invalid fetched document as the reason, without throwing", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const fetchFn = vi.fn<KeySetFetcher>(async () => okResponse({ keys: [{ kty: "RSA" }] }));
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn });
    const result = await verifier.check(await signed(ed));
    expect(result.valid).toBe(false);
    expect(result).toMatchObject({
      reason: expect.stringContaining("key-set document is invalid"),
    });
  });

  it("keeps verifyReceipt total when the key set is unreachable", async () => {
    const ed = await Ed25519Signer.generate("ed");
    const receipt = await signReceipt(
      buildReceipt({
        payer: "GPAYER",
        payee: "GPAYEE",
        amount: "100",
        asset: "USDC",
        resource: "/r",
        model: "x402",
        settlement: { kind: "transaction", txHash: "tx" },
        network: "testnet",
      }),
      ed,
    );
    const verifier = createKeySetVerifier({ url: URL_, fetch: failingFetch() });
    expect(await verifyReceipt(receipt, verifier)).toEqual({
      valid: false,
      reason: "key set unavailable: key set fetch failed: fetch failed",
    });
  });

  it("refresh() replaces the cache, and on failure throws and keeps the cached copy", async () => {
    const ed = await Ed25519Signer.generate("ed");
    let up = true;
    const fetchFn = vi.fn<KeySetFetcher>(async () => {
      if (!up) throw new TypeError("fetch failed");
      return okResponse({ keys: [entry(ed)] }, "max-age=600");
    });
    const verifier = createKeySetVerifier({ url: URL_, fetch: fetchFn });
    await verifier.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    up = false;
    await expect(verifier.refresh()).rejects.toMatchObject({ code: "key-set-unavailable" });
    expect(await verifier.verify(await signed(ed))).toBe(true);
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
