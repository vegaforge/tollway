import { base64UrlToBytes } from "@vegaforge/tollway-core";

/**
 * Header values can be decoded from two base64 alphabets. x402 V2 writes
 * standard base64 (`encodePaymentRequiredHeader` in `@x402/core/http`, which
 * pads with `=`), while Tollway's `encodeHeader` in
 * `packages/server/src/headers.ts` writes unpadded base64url. The playground
 * shows which one a pasted value used so the difference stays visible.
 */
export type HeaderEncoding = "json" | "base64" | "base64url";

/**
 * Node rejects a request whose headers add up to more than 16 KiB by default,
 * so a single header value larger than that never reaches a real service.
 * Refusing it here also keeps a huge paste from freezing the page.
 */
export const MAX_HEADER_LENGTH = 16 * 1024;

export type DetectedEncoding = {
  encoding: HeaderEncoding;
  /**
   * False when the value only uses characters both alphabets share and its
   * length is a multiple of four, so it decodes to the same bytes either way.
   */
  certain: boolean;
};

export type DecodedText =
  | { ok: true; detected: DetectedEncoding; json: unknown }
  | { ok: false; detected: DetectedEncoding | null; error: string };

const BASE64_ANY = /^[A-Za-z0-9+/_-]*={0,2}$/;
const STANDARD_ONLY = /[+/]/;
const URL_ONLY = /[-_]/;

/** Works out which encoding a pasted value uses, or why it is neither. */
export function detectEncoding(
  value: string,
): { ok: true; detected: DetectedEncoding } | { ok: false; error: string } {
  if (value.startsWith("{") || value.startsWith("[")) {
    return { ok: true, detected: { encoding: "json", certain: true } };
  }
  if (!BASE64_ANY.test(value)) {
    return {
      ok: false,
      error: "The value contains characters that are neither base64 nor base64url.",
    };
  }
  const hasStandard = STANDARD_ONLY.test(value);
  const hasUrl = URL_ONLY.test(value);
  if (hasStandard && hasUrl) {
    return {
      ok: false,
      error: "The value mixes the base64 (+ /) and base64url (- _) alphabets.",
    };
  }
  if (hasUrl) {
    return { ok: true, detected: { encoding: "base64url", certain: true } };
  }
  // Standard base64 always pads to a multiple of four, so padding or a
  // standard-only character settles it.
  if (hasStandard || value.endsWith("=")) {
    return { ok: true, detected: { encoding: "base64", certain: true } };
  }
  if (value.length % 4 !== 0) {
    return { ok: true, detected: { encoding: "base64url", certain: true } };
  }
  return { ok: true, detected: { encoding: "base64", certain: false } };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Decodes a pasted header value to JSON. Both alphabets go through
 * `base64UrlToBytes` from `@vegaforge/tollway-core`, the same helper the
 * server's `decodeHeader` uses, after the padding is dropped (it re-pads).
 */
export function decodeHeaderText(raw: string): DecodedText {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, detected: null, error: "Paste a header value first." };
  }
  if (value.length > MAX_HEADER_LENGTH) {
    return {
      ok: false,
      detected: null,
      error: `Header values are limited to ${MAX_HEADER_LENGTH} characters; this one has ${value.length}.`,
    };
  }
  const detection = detectEncoding(value);
  if (!detection.ok) {
    return { ok: false, detected: null, error: detection.error };
  }
  const { detected } = detection;

  let text: string;
  if (detected.encoding === "json") {
    text = value;
  } else {
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(value.replace(/=+$/, ""));
    } catch (error) {
      return {
        ok: false,
        detected,
        error: `The value is not valid ${detected.encoding}: ${messageOf(error, "decoding failed")}.`,
      };
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, detected, error: "The decoded bytes are not UTF-8 text." };
    }
  }

  try {
    return { ok: true, detected, json: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      detected,
      error: `The decoded text is not JSON: ${messageOf(error, "parse failed")}.`,
    };
  }
}
