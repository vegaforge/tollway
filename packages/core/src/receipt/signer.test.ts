import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { buildReceipt, signReceipt, verifyReceipt } from "./receipt.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

/** A fresh key in the PKCS#8 form `exportKey("pkcs8")` produces, as base64url. */
async function freshPkcs8Key(): Promise<string> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
}

const receiptInput = {
  payer: "GPAYER",
  payee: "GPAYEE",
  amount: "10000",
  asset: "USDC",
  resource: "/api/quote",
  model: "x402",
  settlement: { kind: "transaction", txHash: "abc" },
  network: "testnet",
} as const;

describe("Ed25519Signer.fromPrivateKey", () => {
  it("signs receipts that verify against its public key (PKCS#8 input)", async () => {
    const signer = await Ed25519Signer.fromPrivateKey(await freshPkcs8Key());
    const signed = await signReceipt(buildReceipt(receiptInput), signer);
    const verifier = new Ed25519Verifier({ [signer.keyId]: bytesToBase64Url(signer.publicKey) });
    await expect(verifyReceipt(signed, verifier)).resolves.toMatchObject({ valid: true });
  });

  it("accepts the raw 32-byte seed inside the PKCS#8 document and derives the same key", async () => {
    const pkcs8 = await freshPkcs8Key();
    const seed = bytesToBase64Url(base64UrlToBytes(pkcs8).subarray(16));
    const fromPkcs8 = await Ed25519Signer.fromPrivateKey(pkcs8);
    const fromSeed = await Ed25519Signer.fromPrivateKey(seed);
    expect(fromSeed.keyId).toBe(fromPkcs8.keyId);
    const signed = await signReceipt(buildReceipt(receiptInput), fromSeed);
    await expect(
      verifyReceipt(signed, Ed25519Verifier.forSigner(fromPkcs8)),
    ).resolves.toMatchObject({ valid: true });
  });

  it("derives a stable keyId from the key, so every instance publishes the same id", async () => {
    const key = await freshPkcs8Key();
    const first = await Ed25519Signer.fromPrivateKey(key);
    const second = await Ed25519Signer.fromPrivateKey(key);
    expect(first.keyId).toBe(second.keyId);
    expect(first.keyId).toBe(bytesToBase64Url(first.publicKey));
    expect(first.publicKey).toHaveLength(32);
  });

  it("uses an explicit keyId when one is given", async () => {
    const signer = await Ed25519Signer.fromPrivateKey(await freshPkcs8Key(), "2026-11-key");
    expect(signer.keyId).toBe("2026-11-key");
  });

  it("rejects a key of the wrong length without echoing it", async () => {
    const shortKey = bytesToBase64Url(new Uint8Array(31).fill(7));
    const failure = Ed25519Signer.fromPrivateKey(shortKey);
    await expect(failure).rejects.toMatchObject({ code: "invalid-signing-key" });
    await expect(failure).rejects.toThrow(/got 31 bytes/);
    await expect(failure).rejects.not.toThrow(shortKey);
  });

  it("rejects a value that is not base64url", async () => {
    await expect(Ed25519Signer.fromPrivateKey("not a key!")).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });

  it("rejects a 48-byte value that is not an Ed25519 PKCS#8 document", async () => {
    const wrongHeader = bytesToBase64Url(new Uint8Array(48).fill(1));
    await expect(Ed25519Signer.fromPrivateKey(wrongHeader)).rejects.toMatchObject({
      code: "invalid-signing-key",
    });
  });
});
