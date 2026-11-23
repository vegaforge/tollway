import { describe, expect, it } from "vitest";
import { TollwayError } from "../errors.js";
import type { PaymentOffer } from "../types.js";
import {
  type BuildReceiptInput,
  buildReceipt,
  hashOffer,
  signReceipt,
  verifyReceipt,
} from "./receipt.js";
import { receiptBodySchema } from "./schema.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

const x402Input: BuildReceiptInput = {
  payer: "GAGENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  payee: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  resource: "https://api.example.com/quotes/latest",
  model: "x402",
  settlement: { kind: "transaction", txHash: "abc123" },
  network: "testnet",
};

describe("buildReceipt", () => {
  it("fills version, id, and issuedAt", () => {
    const receipt = buildReceipt(x402Input);
    expect(receipt.version).toBe(1);
    expect(receipt.id).not.toBe("");
    expect(Date.parse(receipt.issuedAt)).not.toBeNaN();
  });

  it("rejects a non-integer amount", () => {
    expect(() => buildReceipt({ ...x402Input, amount: "10.5" })).toThrow(TollwayError);
    expect(() => buildReceipt({ ...x402Input, amount: "-3" })).toThrow(TollwayError);
  });

  it("rejects a settlement reference that contradicts the model", () => {
    expect(() =>
      buildReceipt({
        ...x402Input,
        model: "mpp-channel",
      }),
    ).toThrow(/settles via "channel-commitment"/);
  });

  it("accepts a channel receipt with a commitment reference", () => {
    const receipt = buildReceipt({
      ...x402Input,
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "chan-1", sequence: 41 },
    });
    expect(receipt.settlement.kind).toBe("channel-commitment");
  });
});

describe("TM-06 receipt signed by untrusted key", () => {
  it("round-trips a receipt", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(x402Input), signer);

    expect(signed.signature.keyId).toBe("test-key");
    expect(signed.signature.algorithm).toBe("Ed25519");
    expect(await verifyReceipt(signed, verifier)).toEqual({ valid: true, receipt: signed });
  });

  it("flags a tampered amount", async () => {
    const signer = await Ed25519Signer.generate();
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(x402Input), signer);

    const tampered = { ...signed, receipt: { ...signed.receipt, amount: "999999" } };
    const result = await verifyReceipt(tampered, verifier);
    expect(result.valid).toBe(false);
  });

  it("rejects a receipt signed by a key the verifier does not trust", async () => {
    const signer = await Ed25519Signer.generate();
    const stranger = await Ed25519Signer.generate();
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(x402Input), stranger);

    const result = await verifyReceipt(signed, verifier);
    expect(result.valid).toBe(false);
  });

  it("rejects shapes that are not receipts at all", async () => {
    const signer = await Ed25519Signer.generate();
    const verifier = Ed25519Verifier.forSigner(signer);
    const result = await verifyReceipt({ hello: "world" }, verifier);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("receipt");
    }
  });

  it("produces the same signature for the same body regardless of key order", async () => {
    const signer = await Ed25519Signer.generate();
    const body = buildReceipt(x402Input);
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as typeof body;
    const a = await signReceipt(body, signer);
    const b = await signReceipt(reordered, signer);
    expect(a.signature.value).toBe(b.signature.value);
  });
});

// Regression lock for ADR-2026-11-18-strict-receipt-verification: every field
// of a verified receipt was covered by the signature.
describe("TM-05 tampered receipt fields", () => {
  async function signedPair() {
    const signer = await Ed25519Signer.generate("strict-key");
    const signed = await signReceipt(buildReceipt(x402Input), signer);
    return { signed, verifier: Ed25519Verifier.forSigner(signer) };
  }

  it("rejects an unsigned field added to the receipt body", async () => {
    const { signed, verifier } = await signedPair();
    const tampered = { ...signed, receipt: { ...signed.receipt, refunded: "true" } };
    const result = await verifyReceipt(tampered, verifier);
    expect(result.valid).toBe(false);
  });

  it("rejects an unsigned field added to the envelope or the signature", async () => {
    const { signed, verifier } = await signedPair();
    await expect(verifyReceipt({ ...signed, note: "paid" }, verifier)).resolves.toMatchObject({
      valid: false,
    });
    await expect(
      verifyReceipt({ ...signed, signature: { ...signed.signature, trusted: true } }, verifier),
    ).resolves.toMatchObject({ valid: false });
  });

  it("returns the parsed receipt so callers never keep their unchecked input", async () => {
    const { signed, verifier } = await signedPair();
    const result = await verifyReceipt(structuredClone(signed), verifier);
    expect(result).toEqual({ valid: true, receipt: signed });
  });
});

describe("hashOffer (Issue #166)", () => {
  const baseOffer: PaymentOffer = {
    resource: "https://api.example.com/x",
    amount: "10000",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    payTo: "GPAYEESKFIBHLLNBWMG6YXZIJPUKETNUEPAUU5DGKUHX5F5V5NXHSXDM",
    network: "testnet",
    models: ["x402"],
  };

  it("is deterministic for the same offer", async () => {
    const a = await hashOffer(baseOffer);
    const b = await hashOffer({ ...baseOffer });
    expect(a).toBe(b);
  });

  it("changes when the model list changes", async () => {
    const a = await hashOffer(baseOffer);
    const b = await hashOffer({ ...baseOffer, models: ["x402", "mpp-charge"] });
    expect(a).not.toBe(b);
  });

  it("changes when the facilitator URL changes", async () => {
    const a = await hashOffer(baseOffer);
    const b = await hashOffer({ ...baseOffer, facilitatorUrl: "https://facilitator.example" });
    expect(a).not.toBe(b);
  });

  it("changes when the model order changes (the payer saw the ordered list)", async () => {
    const a = await hashOffer({ ...baseOffer, models: ["x402", "mpp-charge"] });
    const b = await hashOffer({ ...baseOffer, models: ["mpp-charge", "x402"] });
    expect(a).not.toBe(b);
  });
});

describe("receipt v2 (Issue #166)", () => {
  const v2Input: BuildReceiptInput = {
    ...x402Input,
    offerHash: "offer-hash-placeholder",
    method: "GET",
  };

  it("buildReceipt returns a v2 receipt when offerHash and method are set", () => {
    const receipt = buildReceipt(v2Input);
    expect(receipt.version).toBe(2);
    if (receipt.version === 2) {
      expect(receipt.offerHash).toBe("offer-hash-placeholder");
      expect(receipt.method).toBe("GET");
    }
  });

  it("buildReceipt returns a v1 receipt when offerHash and method are absent", () => {
    const receipt = buildReceipt(x402Input);
    expect(receipt.version).toBe(1);
  });

  it("rejects an expiresAt that is not strictly after issuedAt", () => {
    expect(() =>
      buildReceipt({
        ...v2Input,
        issuedAt: "2026-11-23T12:00:00.000Z",
        expiresAt: "2026-11-23T12:00:00.000Z",
      }),
    ).toThrow(/expiresAt/);
    expect(() =>
      buildReceipt({
        ...v2Input,
        issuedAt: "2026-11-23T12:00:01.000Z",
        expiresAt: "2026-11-23T12:00:00.000Z",
      }),
    ).toThrow(/expiresAt/);
  });

  it("verifyReceipt rejects an expired v2 receipt and accepts one before expiry", async () => {
    const signer = await Ed25519Signer.generate("v2-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const receipt = await signReceipt(
      buildReceipt({
        ...v2Input,
        issuedAt: "2026-11-23T12:00:00.000Z",
        expiresAt: "2026-11-23T12:30:00.000Z",
      }),
      signer,
    );
    const before = await verifyReceipt(receipt, verifier, {
      now: Date.parse("2026-11-23T12:15:00.000Z"),
    });
    expect(before.valid).toBe(true);
    const after = await verifyReceipt(receipt, verifier, {
      now: Date.parse("2026-11-23T12:45:00.000Z"),
    });
    expect(after.valid).toBe(false);
    if (!after.valid) expect(after.reason).toBe("receipt expired");
  });

  it("a v2 receipt without expiresAt never expires", async () => {
    const signer = await Ed25519Signer.generate("v2-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const receipt = await signReceipt(buildReceipt(v2Input), signer);
    const far = await verifyReceipt(receipt, verifier, {
      now: Date.parse("2099-01-01T00:00:00.000Z"),
    });
    expect(far.valid).toBe(true);
  });

  it("a v1 receipt still verifies against a v1 schema path", async () => {
    const signer = await Ed25519Signer.generate("v1-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const receipt = await signReceipt(buildReceipt(x402Input), signer);
    expect(receipt.receipt.version).toBe(1);
    const result = await verifyReceipt(receipt, verifier);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered method field", async () => {
    const signer = await Ed25519Signer.generate("v2-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(v2Input), signer);
    const tampered = {
      ...signed,
      receipt: { ...signed.receipt, method: "POST" },
    };
    const result = await verifyReceipt(tampered, verifier);
    expect(result.valid).toBe(false);
  });

  it("rejects a tampered offerHash field", async () => {
    const signer = await Ed25519Signer.generate("v2-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(v2Input), signer);
    const tampered = {
      ...signed,
      receipt: { ...signed.receipt, offerHash: "different-hash" },
    };
    const result = await verifyReceipt(tampered, verifier);
    expect(result.valid).toBe(false);
  });
});

describe("review fixes for receipt v2 and verification", () => {
  it("refuses offerHash without method, or method without offerHash, instead of dropping it", () => {
    expect(() =>
      buildReceipt({ ...x402Input, offerHash: "A".repeat(43) } as unknown as BuildReceiptInput),
    ).toThrow(/needs both offerHash and method; got only offerHash/);
    expect(() =>
      buildReceipt({ ...x402Input, method: "GET" } as unknown as BuildReceiptInput),
    ).toThrow(/got only method/);
  });

  it("reports only v2 issues for a bad v2 body", () => {
    const result = receiptBodySchema.safeParse({
      ...buildReceipt({ ...x402Input, offerHash: "h", method: "GET" }),
      method: "",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["method"]);
  });

  it("returns a reason, not a throw, for a signature that is not base64url", async () => {
    const signer = await Ed25519Signer.generate("k");
    const signed = await signReceipt(buildReceipt(x402Input), signer);
    const result = await verifyReceipt(
      { ...signed, signature: { ...signed.signature, value: "%%%" } },
      Ed25519Verifier.forSigner(signer),
    );
    expect(result).toEqual({ valid: false, reason: "signature.value is not base64url" });
  });

  it("returns a reason, not a throw, when the verifier throws", async () => {
    const signer = await Ed25519Signer.generate("k");
    const signed = await signReceipt(buildReceipt(x402Input), signer);
    const throwing = {
      async verify(): Promise<boolean> {
        throw new Error("key store offline");
      },
    };
    expect(await verifyReceipt(signed, throwing)).toEqual({
      valid: false,
      reason: "the verifier failed: key store offline",
    });
  });

  it("checks the signature before expiry, so a forged expired receipt is reported as forged", async () => {
    const signer = await Ed25519Signer.generate("k");
    const signed = await signReceipt(
      buildReceipt({
        ...x402Input,
        issuedAt: "2026-01-01T00:00:00.000Z",
        offerHash: "h",
        method: "GET",
        expiresAt: "2026-01-02T00:00:00.000Z",
      }),
      signer,
    );
    const later = Date.parse("2026-02-01T00:00:00.000Z");
    const verifier = Ed25519Verifier.forSigner(signer);
    expect(await verifyReceipt(signed, verifier, { now: later })).toEqual({
      valid: false,
      reason: "receipt expired",
    });
    const forged = { ...signed, receipt: { ...signed.receipt, amount: "1" } };
    expect(await verifyReceipt(forged, verifier, { now: later })).toEqual({
      valid: false,
      reason: "signature does not verify against any trusted key",
    });
  });

  it("treats EdDSA as the JOSE name for Ed25519, and a malformed trusted key as no match", async () => {
    const signer = await Ed25519Signer.generate("k");
    const message = new Uint8Array([1, 2, 3]);
    const signature = await signer.sign(message);
    const verifier = Ed25519Verifier.forSigner(signer);
    expect(await verifier.verify({ message, signature, keyId: "k", algorithm: "EdDSA" })).toBe(
      true,
    );
    const broken = new Ed25519Verifier({ k: new Uint8Array(5) });
    expect(await broken.verify({ message, signature, keyId: "k", algorithm: "Ed25519" })).toBe(
      false,
    );
  });
});
