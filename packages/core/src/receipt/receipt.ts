import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import type { PaymentOffer } from "../types.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import {
  type ReceiptBody,
  type ReceiptBodyV1,
  type ReceiptBodyV2,
  receiptBodySchema,
  type SignedReceipt,
  signedReceiptSchema,
} from "./schema.js";
import type { ReceiptSigner, ReceiptVerifier, SignatureCheck, SignatureInput } from "./signer.js";

/**
 * Input to {@link buildReceipt}. The function returns a v2 receipt when the
 * caller supplies `offerHash` and `method`, and a v1 receipt when it supplies
 * neither. Supplying only one of the two throws, so a v2 field is never
 * dropped silently. `version` is set by the function, so callers do not
 * provide it. `id` and `issuedAt` default to a fresh UUID and the current
 * time.
 */
export type BuildReceiptInput =
  | (Omit<ReceiptBodyV1, "version" | "id" | "issuedAt"> & {
      id?: string;
      issuedAt?: string;
    })
  | (Omit<ReceiptBodyV2, "version" | "id" | "issuedAt"> & {
      id?: string;
      issuedAt?: string;
    });

function isV2Input(input: BuildReceiptInput): input is Omit<
  ReceiptBodyV2,
  "version" | "id" | "issuedAt"
> & {
  id?: string;
  issuedAt?: string;
} {
  return (
    "offerHash" in input &&
    typeof input.offerHash === "string" &&
    "method" in input &&
    typeof input.method === "string"
  );
}

/**
 * Assembles and validates a receipt body. Throws a TollwayError when the
 * input does not satisfy the canonical schema, including the rule that the
 * settlement reference kind must match the model and, for v2, that
 * `expiresAt` is strictly after `issuedAt`.
 */
export function buildReceipt(input: BuildReceiptInput): ReceiptBody {
  const fields = input as Record<string, unknown>;
  if (
    !isV2Input(input) &&
    (fields.offerHash !== undefined ||
      fields.method !== undefined ||
      fields.expiresAt !== undefined)
  ) {
    const present = ["offerHash", "method", "expiresAt"].filter(
      (field) => fields[field] !== undefined,
    );
    throw new TollwayError(
      "invalid-receipt",
      `a v2 receipt needs both offerHash and method; got only ${present.join(", ")}`,
    );
  }
  const id = input.id ?? crypto.randomUUID();
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const common = {
    id,
    issuedAt,
    payer: input.payer,
    payee: input.payee,
    amount: input.amount,
    asset: input.asset,
    resource: input.resource,
    model: input.model,
    settlement: input.settlement,
    network: input.network,
  };
  const candidate = isV2Input(input)
    ? {
        version: 2 as const,
        ...common,
        offerHash: input.offerHash,
        method: input.method,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      }
    : {
        version: 1 as const,
        ...common,
      };
  const parsed = receiptBodySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError("invalid-receipt", parsed.error.issues.map(formatIssue).join("; "));
  }
  return parsed.data;
}

/**
 * Hashes the fields of a {@link PaymentOffer} that distinguish one offer
 * from another. Two offers that differ in models, facilitator URL, or
 * routing hint produce different hashes, so a v2 receipt is bound to the
 * exact offer the payer accepted.
 *
 * The hash is base64url of SHA-256 over the RFC 8785 canonical bytes of a
 * projection of the offer. The projection is stable: dropping or renaming
 * a field is a receipt-format version bump.
 *
 * Returned as a Promise so the function uses `crypto.subtle.digest` and
 * runs in every runtime Tollway supports.
 */
export async function hashOffer(offer: PaymentOffer): Promise<string> {
  const projection: JsonValue = {
    resource: offer.resource,
    amount: offer.amount,
    asset: offer.asset,
    payTo: offer.payTo,
    network: offer.network,
    // `models` is ordered: the service's preference list is part of the
    // offer the payer saw, so different orders are different offers.
    models: [...offer.models],
    ...(offer.mppSessionSupported === undefined
      ? {}
      : { mppSessionSupported: offer.mppSessionSupported }),
    ...(offer.facilitatorUrl === undefined ? {} : { facilitatorUrl: offer.facilitatorUrl }),
    ...(offer.quote === undefined ? {} : { quote: offer.quote }),
  };
  const bytes = canonicalBytes(projection);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return bytesToBase64Url(digest);
}

/**
 * Signs a receipt body over its canonical bytes, so any party that knows the
 * signer's public key can verify it later with {@link verifyReceipt}. The body
 * is parsed again first, so an invalid body throws instead of being signed.
 */
export async function signReceipt(
  body: ReceiptBody,
  signer: ReceiptSigner,
): Promise<SignedReceipt> {
  const receipt = receiptBodySchema.parse(body);
  const signature = await signer.sign(canonicalBytes(receipt as JsonValue));
  return {
    receipt,
    signature: {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      value: bytesToBase64Url(signature),
    },
  };
}

/** The result of {@link verifyReceipt}: the verified receipt, or why it was refused. */
export type ReceiptVerification =
  | {
      valid: true;
      /**
       * The receipt as parsed and verified. Use this value, not the input:
       * it is exactly what the signature covers.
       */
      receipt: SignedReceipt;
    }
  | { valid: false; reason: string };

/** Options for {@link verifyReceipt}. */
export type VerifyReceiptOptions = {
  /**
   * Current time in ms, used to check a v2 receipt's `expiresAt`. Defaults
   * to `Date.now()`. A v1 receipt never expires; a v2 receipt with no
   * `expiresAt` never expires either.
   */
  now?: number;
};

/**
 * Checks a signed receipt against the schema and the verifier's trusted
 * keys. Accepts unknown as input on purpose: receipts arrive over the wire,
 * and the schema is the gate. Any field the signature does not cover makes
 * the receipt invalid, and a valid result carries the parsed receipt.
 *
 * For a v2 receipt that carries `expiresAt`, verification also fails when
 * `options.now` (or the current time) is at or past the expiry.
 */
export async function verifyReceipt(
  candidate: unknown,
  verifier: ReceiptVerifier,
  options: VerifyReceiptOptions = {},
): Promise<ReceiptVerification> {
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return { valid: false, reason: parsed.error.issues.map(formatIssue).join("; ") };
  }
  const { receipt, signature } = parsed.data;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature.value);
  } catch {
    return { valid: false, reason: "signature.value is not base64url" };
  }
  const check = await checkSignature(verifier, {
    message: canonicalBytes(receipt as JsonValue),
    signature: signatureBytes,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
  });
  if (!check.valid) {
    return check;
  }
  // Expiry is checked after the signature, so "receipt expired" is only ever
  // said about a receipt the trusted key really signed.
  if (receipt.version === 2 && receipt.expiresAt !== undefined) {
    const expires = Date.parse(receipt.expiresAt);
    const now = options.now ?? Date.now();
    if (Number.isFinite(expires) && now >= expires) {
      return { valid: false, reason: "receipt expired" };
    }
  }
  return { valid: true, receipt: parsed.data };
}

/**
 * Asks the verifier about one signature, with a reason when it can give one.
 * `verifyReceipt` takes `unknown` from the wire and must never throw, so a
 * verifier that throws (a bug, or a key set it cannot reach) is reported as
 * an invalid receipt with the error's message.
 */
async function checkSignature(
  verifier: ReceiptVerifier,
  input: SignatureInput,
): Promise<SignatureCheck> {
  try {
    if (verifier.check) {
      return await verifier.check(input);
    }
    return (await verifier.verify(input))
      ? { valid: true }
      : { valid: false, reason: "signature does not verify against any trusted key" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `the verifier failed: ${message}` };
  }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
