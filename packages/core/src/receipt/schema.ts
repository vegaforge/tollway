import { z } from "zod";
import { settlementModels, stellarNetworks } from "../types.js";

/**
 * The canonical receipt, as a runtime schema. Every settlement path in
 * Tollway, x402, MPP charge, and MPP channel, ends in exactly this shape.
 * See docs/design.md, "One receipt format".
 */

/**
 * How the payment is anchored on chain. x402 and MPP charge point at a
 * Stellar transaction; channel payments point at a channel id plus their
 * position in the cumulative commitment stream.
 */
export const settlementRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transaction"),
    txHash: z.string().min(1),
  }),
  z.object({
    kind: z.literal("channel-commitment"),
    channelId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  }),
]);

export type SettlementRef = z.infer<typeof settlementRefSchema>;

const refKindForModel = {
  x402: "transaction",
  "mpp-charge": "transaction",
  "mpp-channel": "channel-commitment",
} as const;

export const receiptBodySchema = z
  .object({
    version: z.literal(1),
    /** Unique per receipt. The signature covers it, so replays are detectable. */
    id: z.string().min(1),
    payer: z.string().min(1),
    payee: z.string().min(1),
    /** Integer string in the asset's smallest unit. Strings keep 64-bit amounts exact. */
    amount: z.string().regex(/^[0-9]+$/, "amount must be an integer string"),
    asset: z.string().min(1),
    /** URL or stable identifier of what was paid for. */
    resource: z.string().min(1),
    model: z.enum(settlementModels),
    settlement: settlementRefSchema,
    network: z.enum(stellarNetworks),
    issuedAt: z.iso.datetime(),
  })
  .superRefine((body, ctx) => {
    // A receipt claiming x402 settlement with a channel reference (or the
    // reverse) is malformed no matter who signed it.
    if (body.settlement.kind !== refKindForModel[body.model]) {
      ctx.addIssue({
        code: "custom",
        path: ["settlement", "kind"],
        message: `model "${body.model}" settles via "${refKindForModel[body.model]}", got "${body.settlement.kind}"`,
      });
    }
  });

export type ReceiptBody = z.infer<typeof receiptBodySchema>;

export const receiptSignatureSchema = z.object({
  /** Identifies the signing key, so keys can rotate without orphaning receipts. */
  keyId: z.string().min(1),
  algorithm: z.string().min(1),
  /** base64url over the canonical bytes of the receipt body. */
  value: z.string().min(1),
});

export type ReceiptSignature = z.infer<typeof receiptSignatureSchema>;

export const signedReceiptSchema = z.object({
  receipt: receiptBodySchema,
  signature: receiptSignatureSchema,
});

export type SignedReceipt = z.infer<typeof signedReceiptSchema>;
