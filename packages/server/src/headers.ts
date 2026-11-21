import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "@vegaforge/tollway-core";

/**
 * The x402 V2 header names, per docs/design.md, "The problem". The values
 * these carry are encoded by `@x402/core`, re-exported below, so the wire
 * format cannot drift from what a stock x402 client sends.
 */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
/** The request header that carries the agent's signed x402 payment. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
/** The response header that carries the x402 `SettleResponse` for a settlement. */
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
/**
 * The signed Tollway receipt for a settlement. It travels beside the x402
 * `SettleResponse`, because `PAYMENT-RESPONSE` belongs to x402 now.
 */
export const TOLLWAY_RECEIPT_HEADER = "TOLLWAY-RECEIPT";
/**
 * A signed dynamic-price quote. The gate sends it on the 402 beside the x402
 * challenge (which also carries it in `accepts[0].extra.tollwayQuote`); a
 * client that does not speak x402, such as an MPP client, echoes it here.
 */
export const TOLLWAY_QUOTE_HEADER = "TOLLWAY-QUOTE";

/** MPP sends its credential as `Authorization: Payment <credential>`. */
export const MPP_AUTHORIZATION_HEADER = "Authorization";

/**
 * The x402 V2 encode/decode helpers. They use standard base64 of the JSON
 * value, accept only the standard alphabet (never base64url), and are typed
 * with the shapes in `@x402/core/types`.
 */
export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

/**
 * Encodes one of Tollway's own values (the signed receipt) for a header:
 * JSON, then base64url. The client accepts both alphabets for the receipt.
 */
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
