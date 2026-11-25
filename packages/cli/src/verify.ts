import {
  createKeySetVerifier,
  Ed25519Verifier,
  type KeySetFetcher,
  parseKeySetDocument,
  type ReceiptVerifier,
  type SignedReceipt,
  signedReceiptSchema,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { DecodeError, decodeValue } from "./decode.js";

/**
 * Verifies a signed receipt against keys the operator names. The receipt
 * can be the JSON a service returned or the encoded TOLLWAY-RECEIPT header.
 */

export type VerifyResult =
  | { valid: true; keyId: string; receipt: SignedReceipt }
  | { valid: false; reason: string; keyId?: string };

/** Reads a receipt from JSON text or from an encoded header value. */
export function readReceipt(input: string): SignedReceipt {
  const text = input.trim();
  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DecodeError("the receipt file is not valid JSON");
    }
    const parsed = signedReceiptSchema.safeParse(json);
    if (!parsed.success) throw new DecodeError("the JSON is not a Tollway SignedReceipt");
    return parsed.data;
  }
  const decoded = decodeValue(text);
  if (decoded.shape !== "tollway-signed-receipt") {
    throw new DecodeError("the value decodes, but not to a Tollway SignedReceipt");
  }
  return decoded.value as SignedReceipt;
}

/**
 * Builds a verifier from a keys file. Two forms are accepted: a key-set
 * document (`{ "keys": [...] }`, the form services publish), or a map of
 * key id to base64url Ed25519 public key.
 */
export function verifierFromKeysFile(text: string): ReceiptVerifier {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DecodeError("the keys file is not valid JSON");
  }
  if (typeof json === "object" && json !== null && "keys" in json) {
    return createKeySetVerifier({ document: parseKeySetDocument(json) });
  }
  if (
    typeof json === "object" &&
    json !== null &&
    !Array.isArray(json) &&
    Object.values(json).every((value) => typeof value === "string")
  ) {
    return new Ed25519Verifier(json as Record<string, string>);
  }
  throw new DecodeError(
    'the keys file is neither a key-set document ({"keys": [...]}) nor a map of key id to public key',
  );
}

/** A verifier that fetches a published key set; only that URL is fetched. */
export function verifierFromJwks(url: string, fetcher?: KeySetFetcher): ReceiptVerifier {
  return createKeySetVerifier({ url, ...(fetcher === undefined ? {} : { fetch: fetcher }) });
}

export async function verify(
  receipt: SignedReceipt,
  verifier: ReceiptVerifier,
): Promise<VerifyResult> {
  const result = await verifyReceipt(receipt, verifier);
  if (result.valid) {
    return { valid: true, keyId: receipt.signature.keyId, receipt };
  }
  return { valid: false, reason: result.reason, keyId: receipt.signature.keyId };
}
