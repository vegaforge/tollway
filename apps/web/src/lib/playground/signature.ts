import { parsePaymentPayload } from "@x402/core/schemas";

/** What the playground shows for a PAYMENT-SIGNATURE before any XDR is decoded. */
export type SignatureSummary = {
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  /**
   * The signed Stellar transaction, when the payload is the Stellar exact
   * scheme (`ExactStellarPayloadV2` in `@x402/stellar`). The payer lives
   * inside it, so it has to be decoded to show who paid.
   */
  transaction: string | null;
};

/**
 * Reads the summary from an x402 V2 payment payload. Returns null for
 * anything else, including V1 payloads, which carry no `accepted` block.
 */
export function summarizeSignature(value: unknown): SignatureSummary | null {
  const parsed = parsePaymentPayload(value);
  if (!parsed.success || parsed.data.x402Version !== 2) {
    return null;
  }
  const { accepted, payload } = parsed.data;
  const transaction = payload.transaction;
  return {
    network: accepted.network,
    amount: accepted.amount,
    asset: accepted.asset,
    payTo: accepted.payTo,
    transaction: typeof transaction === "string" ? transaction : null,
  };
}
