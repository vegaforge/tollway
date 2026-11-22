import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { type SettlementModel, stellarNetworks } from "../types.js";
import { type BuildReceiptInput, buildReceipt, signReceipt, verifyReceipt } from "./receipt.js";
import { type ReceiptBody, signedReceiptSchema } from "./schema.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

/** Pinned seed so a CI failure replays exactly, as in reconcile.property.test.ts. */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

const SIGNATURE_MISMATCH = "signature does not verify against any trusted key";

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
let otherVerifier: Ed25519Verifier;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("property-signing-key");
  verifier = Ed25519Verifier.forSigner(signer);
  otherVerifier = Ed25519Verifier.forSigner(await Ed25519Signer.generate("property-other-key"));
});

/**
 * Non-empty text over every UTF-16 code unit: non-ASCII, astral characters
 * and lone surrogates all have to sign and verify.
 */
function textArb(minLength = 1, maxLength = 16): fc.Arbitrary<string> {
  return fc.string({ unit: "binary", minLength, maxLength });
}

/** Integer strings in the asset's smallest unit, never floats. */
const amountArb = fc.bigInt({ min: 0n, max: 1_000_000_000n }).map(String);

const issuedAtArb = fc
  .integer({ min: 0, max: Date.parse("2030-01-01T00:00:00Z") })
  .map((milliseconds) => new Date(milliseconds).toISOString());

const commonFields = {
  id: textArb(),
  payer: textArb(),
  payee: textArb(),
  amount: amountArb,
  asset: textArb(),
  resource: textArb(),
  network: fc.constantFrom(...stellarNetworks),
  issuedAt: issuedAtArb,
};

/** x402 and MPP charge share the transaction settlement reference. */
const transactionInputArb: fc.Arbitrary<BuildReceiptInput> = fc.record({
  ...commonFields,
  model: fc.constantFrom("x402", "mpp-charge") as fc.Arbitrary<SettlementModel>,
  settlement: fc.record({
    kind: fc.constant("transaction" as const),
    txHash: textArb(),
  }),
});

const channelInputArb: fc.Arbitrary<BuildReceiptInput> = fc.record({
  ...commonFields,
  model: fc.constant("mpp-channel" as const),
  settlement: fc.record({
    kind: fc.constant("channel-commitment" as const),
    channelId: textArb(),
    sequence: fc.nat({ max: 10_000 }),
  }),
});

const receiptInputArb = fc.oneof(transactionInputArb, channelInputArb);

type TamperField =
  | "id"
  | "payer"
  | "payee"
  | "amount"
  | "asset"
  | "resource"
  | "model"
  | "settlement"
  | "network"
  | "issuedAt"
  | "sequence";

const TAMPER_FIELDS: TamperField[] = [
  "id",
  "payer",
  "payee",
  "amount",
  "asset",
  "resource",
  "model",
  "settlement",
  "network",
  "issuedAt",
  "sequence",
];

/**
 * Changes exactly one body field while keeping the receipt schema-valid, so a
 * verification failure can only come from the signature no longer covering it.
 * The test asserts both. `version` is left out: any other value fails the
 * schema, so it cannot show what the signature covers.
 */
function tamperBody(body: ReceiptBody, field: TamperField, nonce: number): ReceiptBody {
  switch (field) {
    case "id":
      return { ...body, id: `${body.id}-t${nonce}` };
    case "payer":
      return { ...body, payer: `${body.payer}-t${nonce}` };
    case "payee":
      return { ...body, payee: `${body.payee}-t${nonce}` };
    case "amount":
      return { ...body, amount: (BigInt(body.amount) + 1n).toString() };
    case "asset":
      return { ...body, asset: `${body.asset}-t${nonce}` };
    case "resource":
      return { ...body, resource: `${body.resource}-t${nonce}` };
    case "model":
      // A channel receipt can only carry mpp-channel, so for it the change is
      // to its settlement sequence instead (covered by "sequence" too).
      if (body.settlement.kind === "channel-commitment") {
        return tamperBody(body, "sequence", nonce);
      }
      return { ...body, model: body.model === "x402" ? "mpp-charge" : "x402" };
    case "sequence":
      if (body.settlement.kind === "transaction") {
        return tamperBody(body, "settlement", nonce);
      }
      return {
        ...body,
        settlement: { ...body.settlement, sequence: body.settlement.sequence + 1 },
      };
    case "settlement":
      if (body.settlement.kind === "transaction") {
        return {
          ...body,
          settlement: {
            kind: "transaction",
            txHash: `${body.settlement.txHash}-t${nonce}`,
          },
        };
      }
      return {
        ...body,
        settlement: {
          kind: "channel-commitment",
          channelId: `${body.settlement.channelId}-t${nonce}`,
          sequence: body.settlement.sequence,
        },
      };
    case "network":
      return { ...body, network: body.network === "testnet" ? "mainnet" : "testnet" };
    case "issuedAt":
      return { ...body, issuedAt: new Date(Date.parse(body.issuedAt) + 1).toISOString() };
  }
}

describe("signed receipt properties", () => {
  it("sign then verify succeeds for arbitrary schema-valid bodies", async () => {
    await fc.assert(
      fc.asyncProperty(receiptInputArb, async (input) => {
        const signed = await signReceipt(buildReceipt(input), signer);
        expect(await verifyReceipt(signed, verifier)).toEqual({ valid: true, receipt: signed });
      }),
      ASSERT_OPTS,
    );
  });

  it("fails after any single body field is changed", async () => {
    await fc.assert(
      fc.asyncProperty(
        receiptInputArb,
        fc.constantFrom(...TAMPER_FIELDS),
        fc.nat(10_000),
        async (input, field, nonce) => {
          const signed = await signReceipt(buildReceipt(input), signer);
          const tampered = { ...signed, receipt: tamperBody(signed.receipt, field, nonce) };
          expect(tampered.receipt).not.toEqual(signed.receipt);
          // Still schema-valid, so the rejection below is the signature's.
          expect(signedReceiptSchema.safeParse(tampered).success).toBe(true);
          expect(await verifyReceipt(tampered, verifier)).toEqual({
            valid: false,
            reason: SIGNATURE_MISMATCH,
          });
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("fails with a different key, keyId or signature value", async () => {
    await fc.assert(
      fc.asyncProperty(receiptInputArb, async (input) => {
        const signed = await signReceipt(buildReceipt(input), signer);

        expect((await verifyReceipt(signed, otherVerifier)).valid).toBe(false);

        const unknownKeyId = {
          ...signed,
          signature: { ...signed.signature, keyId: "unknown-property-key" },
        };
        expect((await verifyReceipt(unknownKeyId, verifier)).valid).toBe(false);

        const first = signed.signature.value[0];
        const flipped = `${first === "A" ? "B" : "A"}${signed.signature.value.slice(1)}`;
        const changedSignature = {
          ...signed,
          signature: { ...signed.signature, value: flipped },
        };
        expect((await verifyReceipt(changedSignature, verifier)).valid).toBe(false);
      }),
      ASSERT_OPTS,
    );
  });
});
