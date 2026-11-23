import { z } from "zod";
import { settlementModels, stellarNetworks } from "../types.js";

/**
 * The canonical receipt, as a runtime schema. Every settlement path in
 * Tollway, x402, MPP charge, and MPP channel, ends in exactly this shape.
 * See docs/design.md, "One receipt format".
 */

// Every schema here is strict: an unknown key fails parsing. A receipt is
// only as trustworthy as its signature, and zod's default would silently drop
// fields the signature never covered while the caller kept them
// (ADR-2026-11-18-strict-receipt-verification).

/**
 * How the payment is anchored on chain. x402 and MPP charge point at a
 * Stellar transaction; channel payments point at a channel id plus their
 * position in the cumulative commitment stream.
 */
export const settlementRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("transaction"),
    txHash: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("channel-commitment"),
    channelId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  }),
]);

/** Where a payment is anchored on chain; see {@link settlementRefSchema}. */
export type SettlementRef = z.infer<typeof settlementRefSchema>;

const refKindForModel = {
  x402: "transaction",
  "mpp-charge": "transaction",
  "mpp-channel": "channel-commitment",
} as const;

/** The fields every receipt body carries, independent of its version. */
const commonBodyFields = {
  id: z.string().min(1),
  payer: z.string().min(1),
  payee: z.string().min(1),
  amount: z.string().regex(/^[0-9]+$/, "amount must be an integer string"),
  asset: z.string().min(1),
  resource: z.string().min(1),
  model: z.enum(settlementModels),
  settlement: settlementRefSchema,
  network: z.enum(stellarNetworks),
  issuedAt: z.iso.datetime(),
} as const;

/**
 * The v1 receipt body. Unchanged byte-for-byte from the pre-#166 schema:
 * every v1 receipt signed before this change verifies identically.
 */
export const receiptBodyV1Schema = z
  .strictObject({
    version: z.literal(1),
    ...commonBodyFields,
  })
  .superRefine((body, ctx) => {
    if (body.settlement.kind !== refKindForModel[body.model]) {
      ctx.addIssue({
        code: "custom",
        path: ["settlement", "kind"],
        message: `model "${body.model}" settles via "${refKindForModel[body.model]}", got "${body.settlement.kind}"`,
      });
    }
  });

/**
 * The v2 receipt body (Issue #166). Adds three fields on top of v1:
 *
 * - `offerHash`: base64url SHA-256 of the canonical bytes of the offer the
 *   payer accepted. Two offers that differ in `models`, `facilitatorUrl`
 *   or `mppSessionSupported` produce different hashes, so a receipt is
 *   bound to the exact offer the payer accepted, not only to the URL
 *   and price.
 * - `method`: the HTTP method of the paid request (uppercase, e.g.
 *   `GET`), or any non-empty identifier a non-HTTP gate uses. A receipt
 *   for `GET /x` no longer unlocks `POST /x`.
 * - `expiresAt`: optional ISO 8601 timestamp, strictly after `issuedAt`.
 *   A receipt without `expiresAt` never expires. The field is about how
 *   long a receipt is honoured as proof of access; it does not evict
 *   the settlement cache.
 */
export const receiptBodyV2Schema = z
  .strictObject({
    version: z.literal(2),
    ...commonBodyFields,
    offerHash: z.string().min(1),
    method: z.string().min(1),
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.settlement.kind !== refKindForModel[body.model]) {
      ctx.addIssue({
        code: "custom",
        path: ["settlement", "kind"],
        message: `model "${body.model}" settles via "${refKindForModel[body.model]}", got "${body.settlement.kind}"`,
      });
    }
    if (body.expiresAt !== undefined) {
      const issued = Date.parse(body.issuedAt);
      const expires = Date.parse(body.expiresAt);
      if (Number.isFinite(issued) && Number.isFinite(expires) && expires <= issued) {
        ctx.addIssue({
          code: "custom",
          path: ["expiresAt"],
          message: "expiresAt must be strictly after issuedAt",
        });
      }
    }
  });

/**
 * The receipt body every settlement path produces, discriminated on
 * `version`. The schema also checks that the settlement reference kind
 * fits the model (a transaction for x402 and MPP charge, a channel
 * commitment for MPP channels).
 *
 * A verifier that does not recognise the version returns invalid rather
 * than guessing the layout. Discriminating on `version` picks v1 or v2 up
 * front, so a bad v2 body reports the v2 issues only.
 */
export const receiptBodySchema = z.discriminatedUnion("version", [
  receiptBodyV1Schema,
  receiptBodyV2Schema,
]);

/** A v1 receipt body; see {@link receiptBodyV1Schema}. */
export type ReceiptBodyV1 = z.infer<typeof receiptBodyV1Schema>;
/** A v2 receipt body; see {@link receiptBodyV2Schema}. */
export type ReceiptBodyV2 = z.infer<typeof receiptBodyV2Schema>;
/** The signed part of a receipt: who paid whom, how much, for what, and how it settled. */
export type ReceiptBody = z.infer<typeof receiptBodySchema>;

/** The signature block of a receipt: which key signed, with what algorithm, and the signature. */
export const receiptSignatureSchema = z.strictObject({
  /** Identifies the signing key, so keys can rotate without orphaning receipts. */
  keyId: z.string().min(1),
  algorithm: z.string().min(1),
  /** base64url over the canonical bytes of the receipt body. */
  value: z.string().min(1),
});

/** The signature block of a receipt; see {@link receiptSignatureSchema}. */
export type ReceiptSignature = z.infer<typeof receiptSignatureSchema>;

/**
 * A receipt body with its signature. This is the schema to parse any receipt
 * that arrives from outside; {@link verifyReceipt} applies it before checking
 * the signature.
 */
export const signedReceiptSchema = z.strictObject({
  receipt: receiptBodySchema,
  signature: receiptSignatureSchema,
});

/**
 * The canonical receipt Tollway returns for every settled payment, whatever
 * the model. See docs/design.md, "One receipt format".
 */
export type SignedReceipt = z.infer<typeof signedReceiptSchema>;
