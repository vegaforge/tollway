import { signedReceiptSchema } from "@vegaforge/tollway-core";
import { PaymentPayloadV2Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { z } from "zod";

/**
 * Decoding of the values Tollway and x402 put in headers. Two encodings are
 * in play: x402 V2 headers are standard base64 of JSON, and Tollway's own
 * values (the signed receipt) are base64url of JSON. The decoder accepts
 * either, says which it found, and validates the JSON against the schema of
 * the shape it recognises.
 */

export type Encoding = "base64" | "base64url";

export type Shape =
  | "tollway-signed-receipt"
  | "x402-payment-required"
  | "x402-payment-payload"
  | "x402-settle-response"
  | "tollway-offer";

/** A human name for each shape. */
export const SHAPE_NAMES: Record<Shape, string> = {
  "tollway-signed-receipt": "Tollway SignedReceipt",
  "x402-payment-required": "x402 PaymentRequired",
  "x402-payment-payload": "x402 PaymentPayload",
  "x402-settle-response": "x402 SettleResponse",
  "tollway-offer": "Tollway offer",
};

/** Why a value could not be decoded. Every one is a validation failure. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export type Decoded = {
  encoding: Encoding;
  shape: Shape;
  value: unknown;
};

/** x402's SettleResponse. @x402/core ships a type for it but no schema. */
const settleResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string(),
  network: z.string().min(1),
  payer: z.string().optional(),
  amount: z.string().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  extensionResponses: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

/** Tollway's `PaymentOffer`, as older gates and the docs show it. */
const offerSchema = z.strictObject({
  resource: z.string().min(1),
  amount: z.string().regex(/^[0-9]+$/),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  network: z.enum(["testnet", "mainnet"]),
  models: z.array(z.enum(["x402", "mpp-charge", "mpp-channel"])).min(1),
  mppSessionSupported: z.boolean().optional(),
  facilitatorUrl: z.string().optional(),
  quote: z.string().optional(),
});

/** Most specific first: a receipt also has the keys an offer has, and more. */
const SHAPES: ReadonlyArray<{ shape: Shape; schema: z.ZodType }> = [
  { shape: "tollway-signed-receipt", schema: signedReceiptSchema },
  { shape: "x402-payment-required", schema: PaymentRequiredV2Schema },
  { shape: "x402-payment-payload", schema: PaymentPayloadV2Schema },
  { shape: "x402-settle-response", schema: settleResponseSchema },
  { shape: "tollway-offer", schema: offerSchema },
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/**
 * Strips a leading `Header-Name:` so a line copied from curl output or a
 * browser's network panel decodes as is.
 */
export function stripHeaderName(input: string): string {
  const trimmed = input.trim();
  const match = /^[A-Za-z][A-Za-z0-9-]*:\s*(\S+)$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * Says which alphabet a value uses. A value with neither `+`/`/` nor
 * `-`/`_` is valid in both; it is reported as base64, the x402 encoding.
 */
export function detectEncoding(value: string): Encoding {
  if (value.length === 0) throw new DecodeError("the value is empty");
  const urlChars = /[-_]/.test(value);
  const standardChars = /[+/]/.test(value);
  if (urlChars && standardChars) {
    throw new DecodeError("the value mixes the base64 and base64url alphabets");
  }
  if (urlChars) {
    if (!BASE64URL.test(value)) throw new DecodeError("the value is not base64url");
    return "base64url";
  }
  if (!BASE64.test(value)) throw new DecodeError("the value is not base64 or base64url");
  return "base64";
}

/** Returns `value` without its trailing `=` padding. */
export function trimPadding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "=") end -= 1;
  return value.slice(0, end);
}

function decodeBytes(value: string, encoding: Encoding): Uint8Array {
  const standard =
    encoding === "base64url" ? value.replaceAll("-", "+").replaceAll("_", "/") : value;
  const unpadded = trimPadding(standard);
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new DecodeError(`the value is not valid ${encoding}`);
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Parses JSON text and names the shape it matches. */
export function classify(json: unknown): { shape: Shape; value: unknown } {
  for (const { shape, schema } of SHAPES) {
    const parsed = schema.safeParse(json);
    if (parsed.success) return { shape, value: parsed.data };
  }
  throw new DecodeError(
    `the JSON is none of: ${SHAPES.map(({ shape }) => SHAPE_NAMES[shape]).join(", ")}`,
  );
}

/** Decodes one header value, in either encoding, and validates it. */
export function decodeValue(input: string): Decoded {
  const value = stripHeaderName(input);
  const encoding = detectEncoding(value);
  const text = new TextDecoder("utf-8", { fatal: true });
  let json: unknown;
  try {
    json = JSON.parse(text.decode(decodeBytes(value, encoding)));
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(`the decoded ${encoding} is not JSON`);
  }
  return { encoding, ...classify(json) };
}
