import {
  type PaymentOffer,
  settlementModels,
  signedReceiptSchema,
  stellarNetworks,
} from "@vegaforge/tollway-core";
import { parsePaymentPayload, parsePaymentRequired } from "@x402/core/schemas";
import type { Network, SettleResponse } from "@x402/core/types";
import { z } from "zod";

import type { HeaderEncoding } from "./encoding";

/** The headers the playground understands. */
export const headerNames = [
  "PAYMENT-REQUIRED",
  "PAYMENT-SIGNATURE",
  "PAYMENT-RESPONSE",
  "TOLLWAY-RECEIPT",
] as const;

export type HeaderName = (typeof headerNames)[number];

/**
 * Every shape a header can carry today. The gate in `packages/server` still
 * sends Tollway shapes (a `PaymentOffer` in PAYMENT-REQUIRED and the signed
 * receipt in PAYMENT-RESPONSE); x402 V2 services send `PaymentRequired`,
 * `PaymentPayload` and `SettleResponse`. #43 moves the gate to the x402
 * shapes plus a separate TOLLWAY-RECEIPT header.
 */
export type ShapeId =
  | "x402-payment-required"
  | "x402-payment-payload"
  | "x402-settle-response"
  | "tollway-offer"
  | "tollway-receipt";

type ShapeInfo = {
  label: string;
  family: "x402" | "tollway";
  /** The encoding the producer of this shape writes. */
  expectedEncoding: Exclude<HeaderEncoding, "json">;
};

export const shapeInfo: Record<ShapeId, ShapeInfo> = {
  "x402-payment-required": {
    label: "x402 PaymentRequired",
    family: "x402",
    expectedEncoding: "base64",
  },
  "x402-payment-payload": {
    label: "x402 PaymentPayload",
    family: "x402",
    expectedEncoding: "base64",
  },
  "x402-settle-response": {
    label: "x402 SettleResponse",
    family: "x402",
    expectedEncoding: "base64",
  },
  "tollway-offer": {
    label: "Tollway payment offer",
    family: "tollway",
    expectedEncoding: "base64url",
  },
  "tollway-receipt": {
    label: "Tollway signed receipt",
    family: "tollway",
    expectedEncoding: "base64url",
  },
};

/** Which shapes each header may carry, in the order they are tried. */
export const shapesForHeader: Record<HeaderName, readonly ShapeId[]> = {
  "PAYMENT-REQUIRED": ["x402-payment-required", "tollway-offer"],
  "PAYMENT-SIGNATURE": ["x402-payment-payload"],
  "PAYMENT-RESPONSE": ["x402-settle-response", "tollway-receipt"],
  "TOLLWAY-RECEIPT": ["tollway-receipt"],
};

/**
 * Core exports the `PaymentOffer` type but no runtime schema for it, so the
 * playground mirrors the type here. The `satisfies` check below fails the
 * typecheck if the type and this schema drift apart.
 */
const tollwayOfferSchema = z.strictObject({
  resource: z.string().min(1),
  amount: z.string().regex(/^[0-9]+$/, "amount must be an integer string"),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  network: z.enum(stellarNetworks),
  models: z.array(z.enum(settlementModels)).min(1),
  mppSessionSupported: z.boolean().optional(),
  facilitatorUrl: z.string().optional(),
});

/**
 * `@x402/core` types `SettleResponse` but ships no schema for it, so it is
 * written out from the type in `@x402/core/types` (2.31.0).
 */
const settleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(),
  // CAIP-2, the same rule NetworkSchemaV2 in @x402/core/schemas applies.
  network: z.custom<Network>(
    (value) => typeof value === "string" && /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value),
    "network must be a CAIP-2 id such as stellar:testnet",
  ),
  amount: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  extensionResponses: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

// Compile-time guards: each schema's output must be assignable to the
// package type it stands in for.
type Assignable<T extends U, U> = T;
export type OfferSchemaMatchesCore = Assignable<z.infer<typeof tollwayOfferSchema>, PaymentOffer>;
export type SettleSchemaMatchesX402 = Assignable<
  z.infer<typeof settleResponseSchema>,
  SettleResponse
>;

type Issue = { path: PropertyKey[]; message: string };

function formatIssues(issues: readonly Issue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

type Validation = { ok: true; value: unknown } | { ok: false; errors: string[] };

function validate(shape: ShapeId, value: unknown): Validation {
  const result = (() => {
    switch (shape) {
      case "x402-payment-required":
        return parsePaymentRequired(value);
      case "x402-payment-payload":
        return parsePaymentPayload(value);
      case "x402-settle-response":
        return settleResponseSchema.safeParse(value);
      case "tollway-offer":
        return tollwayOfferSchema.safeParse(value);
      case "tollway-receipt":
        return signedReceiptSchema.safeParse(value);
    }
  })();
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: formatIssues(result.error.issues) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * When nothing validates, pick the shape the value was most likely meant to
 * be, so the errors shown are the useful ones. The keys tested here are the
 * ones that only one shape has.
 */
function likelyShape(candidates: readonly ShapeId[], value: unknown): ShapeId {
  const fallback = candidates[0];
  if (fallback === undefined) {
    throw new Error("Every header has at least one candidate shape.");
  }
  if (!isRecord(value)) {
    return fallback;
  }
  const hints: Record<ShapeId, boolean> = {
    "x402-payment-required": "x402Version" in value && "accepts" in value,
    "x402-payment-payload": "x402Version" in value && "accepted" in value,
    "x402-settle-response": "success" in value,
    "tollway-offer": "models" in value || ("payTo" in value && !("x402Version" in value)),
    "tollway-receipt": "receipt" in value && "signature" in value,
  };
  return candidates.find((shape) => hints[shape]) ?? fallback;
}

export type ShapeMatch = {
  shape: ShapeId;
  valid: boolean;
  errors: string[];
  /** The parsed value when valid, otherwise the decoded JSON as pasted. */
  value: unknown;
};

/** Validates a decoded value against every shape its header may carry. */
export function identifyShape(header: HeaderName, value: unknown): ShapeMatch {
  const candidates = shapesForHeader[header];
  for (const shape of candidates) {
    const result = validate(shape, value);
    if (result.ok) {
      return { shape, valid: true, errors: [], value: result.value };
    }
  }
  const shape = likelyShape(candidates, value);
  const result = validate(shape, value);
  return {
    shape,
    valid: false,
    errors: result.ok ? [] : result.errors,
    value,
  };
}
