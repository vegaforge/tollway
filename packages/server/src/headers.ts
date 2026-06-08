import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "@tollway/core";

/** The x402 header names, per docs/design.md, "The problem". */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Encodes a value for an x402 header: JSON, then base64url. */
export function encodeHeader(value: unknown): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify(value)));
}

/** Reverses encodeHeader. Throws if the value is not valid encoded JSON. */
export function decodeHeader<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
}

/** Case-insensitive header lookup that flattens repeated values. */
export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}
