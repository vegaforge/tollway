import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "@vegaforge/tollway-core";

/** The x402 header names, per docs/design.md, "The problem". */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
/** The request header that carries the agent's signed x402 payment. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
/**
 * The response header on a settled request. The gate sends the signed
 * receipt in it today; #43 moves the receipt to its own header.
 */
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
/** Signed quote returned by a dynamic-price paywall and echoed by the client. */
export const TOLLWAY_QUOTE_HEADER = "TOLLWAY-QUOTE";

/** MPP sends its credential as `Authorization: Payment <credential>`. */
export const MPP_AUTHORIZATION_HEADER = "Authorization";

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

/**
 * Returns the `Payment ...` credential from an Authorization header, or
 * undefined when there is none. The header can list several schemes
 * separated by commas; only the Payment one is MPP's.
 */
export function readMppCredential(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const authorization = readHeader(headers, MPP_AUTHORIZATION_HEADER);
  if (!authorization) {
    return undefined;
  }
  return authorization
    .split(",")
    .map((scheme) => scheme.trim())
    .find((scheme) => /^Payment\s+\S/i.test(scheme));
}
