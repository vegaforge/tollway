import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalBytes,
  type JsonValue,
  type PaymentOffer,
  type ReceiptSigner,
  type ReceiptVerifier,
  type SignedReceipt,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import { DEFAULT_MAX_TIMEOUT_SECONDS, STELLAR_EXACT_SCHEME, stellarCaip2 } from "./facilitator.js";

/**
 * x402 offer-receipt extension (Issue #172).
 *
 * Opt-in attachment of signed offer and receipt JWS tokens in
 * `PaymentRequired.extensions["offer-receipt"]` and
 * `SettleResponse.extensions["offer-receipt"]` (inside `PAYMENT-RESPONSE`).
 * The Tollway canonical receipt remains the source of truth; these payloads
 * are projections of the offer and receipt signed with the same service key.
 */

export const OFFER_RECEIPT_EXTENSION_KEY = "offer-receipt";

export type OfferReceiptConfig = {
  /** Whether to attach offer-receipt extension payloads. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Whether to include `transaction` (the settlement txHash) in the
   * extension receipt payload. Defaults to `false` for privacy.
   */
  includeTxHash?: boolean;
  /**
   * DID used as the JWS `kid` header (for example `did:key:...`, `did:jwk:...`,
   * or `did:web:...`). Defaults to a `did:key` derived from an Ed25519
   * signer's public key when available, or `signer.keyId` otherwise.
   */
  kid?: string;
  /**
   * Offer validity lifetime in seconds, used to compute `validUntil`.
   * Defaults to `maxTimeoutSeconds` (60s).
   */
  validUntilSeconds?: number;
};

export type ResolvedOfferReceiptConfig = {
  includeTxHash: boolean;
  kid?: string;
  validUntilSeconds: number;
};

export type OfferExtensionPayload = {
  version: 1;
  resourceUrl: string;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  validUntil: number;
};

export type ReceiptExtensionPayload = {
  version: 1;
  network: string;
  resourceUrl: string;
  payer: string;
  issuedAt: number;
  transaction?: string;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]!]!;
  }
  return out;
}

/**
 * Encodes a raw 32-byte Ed25519 public key as a `did:key` DID using the
 * multicodec `0xed 0x01` prefix and multibase `z` (base58btc).
 */
export function ed25519PublicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new RangeError(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${encodeBase58(prefixed)}`;
}

/**
 * Resolves the JWS `kid` for a {@link ReceiptSigner}. Uses `explicitKid`
 * when provided, otherwise derives `did:key` if the signer exposes a 32-byte
 * Ed25519 `publicKey`, and falls back to `signer.keyId`.
 */
export function resolveOfferReceiptKid(signer: ReceiptSigner, explicitKid?: string): string {
  if (explicitKid) return explicitKid;
  const candidate = signer as ReceiptSigner & { publicKey?: unknown };
  if (
    signer.algorithm === "Ed25519" &&
    candidate.publicKey instanceof Uint8Array &&
    candidate.publicKey.length === 32
  ) {
    return ed25519PublicKeyToDidKey(candidate.publicKey);
  }
  return signer.keyId;
}

function jwsAlgorithm(algorithm: string): string {
  if (algorithm === "Ed25519" || algorithm === "EdDSA") return "EdDSA";
  return algorithm;
}

/**
 * Resolves `PaywallConfig.offerReceipt` into a concrete configuration, or
 * `undefined` when disabled.
 */
export function resolveOfferReceiptConfig(
  option: boolean | OfferReceiptConfig | undefined,
  maxTimeoutSeconds?: number,
): ResolvedOfferReceiptConfig | undefined {
  if (!option) return undefined;
  if (option === true) {
    return {
      includeTxHash: false,
      validUntilSeconds: maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    };
  }
  if (option.enabled === false) return undefined;
  return {
    includeTxHash: option.includeTxHash ?? false,
    ...(option.kid !== undefined ? { kid: option.kid } : {}),
    validUntilSeconds: option.validUntilSeconds ?? maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
  };
}

async function signJws(
  payload: JsonValue,
  signer: ReceiptSigner,
  kid?: string,
): Promise<string> {
  const header = {
    alg: jwsAlgorithm(signer.algorithm),
    kid: resolveOfferReceiptKid(signer, kid),
  };
  const encodedHeader = bytesToBase64Url(utf8Bytes(JSON.stringify(header)));
  const encodedPayload = bytesToBase64Url(canonicalBytes(payload));
  const signingInput = utf8Bytes(`${encodedHeader}.${encodedPayload}`);
  const signature = await signer.sign(signingInput);
  return `${encodedHeader}.${encodedPayload}.${bytesToBase64Url(signature)}`;
}

/** Signs an x402 offer-receipt offer payload as a compact JWS. */
export async function signOfferJws(
  payload: OfferExtensionPayload,
  signer: ReceiptSigner,
  kid?: string,
): Promise<string> {
  return signJws(payload as unknown as JsonValue, signer, kid);
}

/** Signs an x402 offer-receipt receipt payload as a compact JWS. */
export async function signReceiptJws(
  payload: ReceiptExtensionPayload,
  signer: ReceiptSigner,
  kid?: string,
): Promise<string> {
  return signJws(payload as unknown as JsonValue, signer, kid);
}

/**
 * Builds the `extensions["offer-receipt"]` entry for a 402 `PaymentRequired`
 * challenge from a Tollway {@link PaymentOffer}.
 */
export async function buildOfferReceiptChallengeExtension(input: {
  offer: PaymentOffer;
  signer: ReceiptSigner;
  nowMs: number;
  config: ResolvedOfferReceiptConfig;
  scheme?: string;
}): Promise<{ info: { offers: [string] } }> {
  const payload: OfferExtensionPayload = {
    version: 1,
    resourceUrl: input.offer.resource,
    scheme: input.scheme ?? STELLAR_EXACT_SCHEME,
    network: stellarCaip2(input.offer.network),
    asset: input.offer.asset,
    payTo: input.offer.payTo,
    amount: input.offer.amount,
    validUntil: Math.floor(input.nowMs / 1000) + input.config.validUntilSeconds,
  };
  const jws = await signOfferJws(payload, input.signer, input.config.kid);
  return { info: { offers: [jws] } };
}

/**
 * Builds the `extensions["offer-receipt"]` entry for a `SettleResponse`
 * from a canonical Tollway {@link SignedReceipt}.
 */
export async function buildOfferReceiptSettlementExtension(input: {
  signedReceipt: SignedReceipt;
  signer: ReceiptSigner;
  config: ResolvedOfferReceiptConfig;
}): Promise<{ info: { receipt: string } }> {
  const { receipt } = input.signedReceipt;
  const payload: ReceiptExtensionPayload = {
    version: 1,
    network: stellarCaip2(receipt.network),
    resourceUrl: receipt.resource,
    payer: receipt.payer,
    issuedAt: Math.floor(Date.parse(receipt.issuedAt) / 1000),
    ...(input.config.includeTxHash && receipt.settlement.kind === "transaction"
      ? { transaction: receipt.settlement.txHash }
      : {}),
  };
  const jws = await signReceiptJws(payload, input.signer, input.config.kid);
  return { info: { receipt: jws } };
}

/** Decodes a compact JWS into its header and payload without verifying the signature. */
export function decodeOfferReceiptJws<T = unknown>(jws: string): {
  header: { alg: string; kid?: string; [key: string]: unknown };
  payload: T;
  signingInput: Uint8Array;
  signature: Uint8Array;
} {
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("invalid compact JWS: expected 3 non-empty dot-separated parts");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader))) as {
    alg: string;
    kid?: string;
    [key: string]: unknown;
  };
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as T;
  return {
    header,
    payload,
    signingInput: utf8Bytes(`${encodedHeader}.${encodedPayload}`),
    signature: base64UrlToBytes(encodedSignature),
  };
}

/** Verifies a compact offer or receipt JWS using a Tollway {@link ReceiptVerifier}. */
export async function verifyOfferReceiptJws<T = unknown>(
  jws: string,
  verifier: ReceiptVerifier,
  keyId?: string,
): Promise<{ valid: true; header: { alg: string; kid?: string }; payload: T } | { valid: false; reason: string }> {
  let decoded: ReturnType<typeof decodeOfferReceiptJws<T>>;
  try {
    decoded = decodeOfferReceiptJws<T>(jws);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "invalid JWS" };
  }
  const resolvedKeyId = keyId ?? decoded.header.kid;
  if (!resolvedKeyId) {
    return { valid: false, reason: "JWS header missing kid" };
  }
  const algorithm = decoded.header.alg === "EdDSA" ? "Ed25519" : decoded.header.alg;
  const ok = await verifier.verify({
    message: decoded.signingInput,
    signature: decoded.signature,
    keyId: resolvedKeyId,
    algorithm,
  });
  if (!ok) {
    return { valid: false, reason: "JWS signature verification failed" };
  }
  return { valid: true, header: decoded.header, payload: decoded.payload };
}
