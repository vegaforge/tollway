import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";
import { TollwayError } from "../errors.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import {
  type ReceiptBody,
  receiptBodySchema,
  type SignedReceipt,
  signedReceiptSchema,
} from "./schema.js";
import type { ReceiptSigner, ReceiptVerifier } from "./signer.js";

export type BuildReceiptInput = Omit<ReceiptBody, "version" | "id" | "issuedAt"> & {
  id?: string;
  issuedAt?: string;
};

/**
 * Assembles and validates a receipt body. Throws a TollwayError when the
 * input does not satisfy the canonical schema, including the rule that the
 * settlement reference kind must match the model.
 */
export function buildReceipt(input: BuildReceiptInput): ReceiptBody {
  const parsed = receiptBodySchema.safeParse({
    version: 1,
    id: input.id ?? crypto.randomUUID(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    payer: input.payer,
    payee: input.payee,
    amount: input.amount,
    asset: input.asset,
    resource: input.resource,
    model: input.model,
    settlement: input.settlement,
    network: input.network,
  });
  if (!parsed.success) {
    throw new TollwayError("invalid-receipt", parsed.error.issues.map(formatIssue).join("; "));
  }
  return parsed.data;
}

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

export type ReceiptVerification = { valid: true } | { valid: false; reason: string };

/**
 * Checks a signed receipt against the schema and the verifier's trusted
 * keys. Accepts unknown as input on purpose: receipts arrive over the wire,
 * and the schema is the gate.
 */
export async function verifyReceipt(
  candidate: unknown,
  verifier: ReceiptVerifier,
): Promise<ReceiptVerification> {
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return { valid: false, reason: parsed.error.issues.map(formatIssue).join("; ") };
  }
  const { receipt, signature } = parsed.data;
  const matches = await verifier.verify({
    message: canonicalBytes(receipt as JsonValue),
    signature: base64UrlToBytes(signature.value),
    keyId: signature.keyId,
    algorithm: signature.algorithm,
  });
  if (!matches) {
    return { valid: false, reason: "signature does not verify against any trusted key" };
  }
  return { valid: true };
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
