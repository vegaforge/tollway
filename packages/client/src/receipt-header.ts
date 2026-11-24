import {
  base64UrlToBytes,
  type SignedReceipt,
  signedReceiptSchema,
  TollwayError,
} from "@vegaforge/tollway-core";

/**
 * Reading the Tollway receipt a service returns with a paid response. Every
 * settler ends the same way: the receipt rides in a header as base64 JSON
 * and is parsed with `signedReceiptSchema` before anything trusts it.
 */

/** The header the gate puts Tollway's signed receipt in, for every model. */
export const TOLLWAY_RECEIPT_HEADER = "TOLLWAY-RECEIPT";

/**
 * Reads and validates the Tollway receipt from `header` on a paid response.
 * Rejects with `invalid-receipt` when it is missing, not base64 JSON, or not
 * a Tollway receipt.
 */
export function readReceiptHeader(
  response: Response,
  resource: string,
  header: string = TOLLWAY_RECEIPT_HEADER,
): SignedReceipt {
  const value = response.headers.get(header);
  if (!value) {
    throw new TollwayError(
      "invalid-receipt",
      `${resource} settled the payment but sent no ${header} header`,
    );
  }
  let candidate: unknown;
  try {
    // Accepts standard base64 and base64url alike.
    candidate = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
  } catch (error) {
    throw new TollwayError(
      "invalid-receipt",
      `the ${header} header from ${resource} is not base64 JSON: ${messageOf(error)}`,
    );
  }
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `the ${header} header from ${resource} is not a Tollway receipt`,
    );
  }
  return parsed.data;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
