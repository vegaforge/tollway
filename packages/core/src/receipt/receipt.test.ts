import { describe, expect, it } from "vitest";
import { TollwayError } from "../errors.js";
import { type BuildReceiptInput, buildReceipt, signReceipt, verifyReceipt } from "./receipt.js";
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

describe("sign and verify", () => {
  it("round-trips a receipt", async () => {
    const signer = await Ed25519Signer.generate("test-key");
    const verifier = Ed25519Verifier.forSigner(signer);
    const signed = await signReceipt(buildReceipt(x402Input), signer);

    expect(signed.signature.keyId).toBe("test-key");
    expect(signed.signature.algorithm).toBe("Ed25519");
    expect(await verifyReceipt(signed, verifier)).toEqual({ valid: true });
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
