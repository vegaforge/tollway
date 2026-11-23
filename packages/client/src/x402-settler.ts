/**
 * The x402 settler: pays an x402 V2 route on Stellar with @x402/stellar's
 * client scheme and returns the Tollway receipt the service sends back.
 *
 * Wire format, x402 V2 (the format #43 standardises):
 * - The service answers the first request with 402 and a PAYMENT-REQUIRED
 *   header: standard base64 of the `PaymentRequired` JSON.
 * - The agent signs the Soroban auth entry for the SEP-41 transfer and
 *   retries with PAYMENT-SIGNATURE: standard base64 of the `PaymentPayload`.
 * - The service answers with the resource and a TOLLWAY-RECEIPT header:
 *   base64 of the signed Tollway receipt JSON.
 *
 * Header encoding goes through @x402/core/http, so it matches what the
 * x402 SDK itself sends and expects.
 *
 * Spend limits: from @x402/core 2.31 the x402Client applies its own spend
 * controls by default (only assets the scheme recognises, capped at $1 per
 * payment). Tollway's policy engine is the spend authority, so each
 * settlement replaces those defaults with a cap of exactly the approved
 * offer: the one asset the 402 names, at most the approved amount.
 */

import {
  base64UrlToBytes,
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
  TollwayError,
} from "@vegaforge/tollway-core";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { ClientSettler, SettleRequest } from "./index.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const TOLLWAY_RECEIPT_HEADER = "TOLLWAY-RECEIPT";

export type X402SettlerOptions = {
  /**
   * Signs the Soroban auth entry. Build it with
   * `createEd25519Signer("S...", "stellar:testnet")` from @x402/stellar; the
   * settler never sees the secret.
   */
  signer: ClientStellarSigner;
  network: StellarNetwork;
  /** Defaults to the global `fetch`. Inject one in tests. */
  fetch?: typeof globalThis.fetch;
  /** Soroban RPC URL for the scheme's simulations. Defaults to the public one. */
  rpcUrl?: string;
  /** HTTP method for the paid request. Defaults to GET. */
  method?: string;
};

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/**
 * Creates a `ClientSettler` for x402 on Stellar. For each settlement it
 * requests the resource, reads the 402, signs the payment for the Stellar
 * `exact` option, retries with the payment, and returns the receipt.
 *
 * It only pays what the client already approved: the 402's amount and payee
 * must match the offer the policy engine checked, or nothing is signed.
 */
export function createX402Settler(options: X402SettlerOptions): ClientSettler {
  const network = CAIP2[options.network];
  const doFetch = options.fetch ?? globalThis.fetch;
  const method = options.method ?? "GET";
  const scheme = new ExactStellarScheme(
    options.signer,
    options.rpcUrl ? { url: options.rpcUrl } : undefined,
  );

  return {
    async settle({ resource, offer, model }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "x402") {
        throw new TollwayError("payment-failed", `the x402 settler cannot settle model "${model}"`);
      }

      const challenge = await doFetch(resource, { method });
      if (challenge.status !== 402) {
        throw new TollwayError(
          "payment-failed",
          `expected a 402 challenge from ${resource}, got ${challenge.status}`,
        );
      }
      const paymentRequired = readPaymentRequired(challenge, resource);

      const requirements = paymentRequired.accepts.find(
        (option) => option.scheme === "exact" && option.network === network,
      );
      if (!requirements) {
        throw new TollwayError(
          "payment-failed",
          `the 402 from ${resource} has no Stellar exact option for ${network}`,
        );
      }
      assertMatchesOffer(requirements, offer, resource);

      // A client per settlement, so the spend cap belongs to this offer
      // alone and two concurrent settlements cannot see each other's cap.
      const client = x402Client.fromConfig({
        schemes: [{ network, client: scheme }],
        spendControls: {
          allowedAssets: [
            { network, asset: requirements.asset, maxAmountPerPayment: offer.amount },
          ],
        },
      });
      let payload: PaymentPayload;
      try {
        payload = await client.createPaymentPayload({
          ...paymentRequired,
          accepts: [requirements],
        });
      } catch (error) {
        throw new TollwayError(
          "payment-failed",
          `could not sign the x402 payment for ${resource}: ${messageOf(error)}`,
        );
      }

      const paid = await doFetch(resource, {
        method,
        headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payload) },
      });
      if (paid.status === 402) {
        throw new TollwayError(
          "payment-failed",
          `${resource} answered the signed payment with another 402`,
        );
      }
      if (!paid.ok) {
        throw new TollwayError(
          "payment-failed",
          `${resource} answered the signed payment with ${paid.status}`,
        );
      }
      return readReceipt(paid, resource);
    },
  };
}

function readPaymentRequired(response: Response, resource: string): PaymentRequired {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!header) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no ${PAYMENT_REQUIRED_HEADER} header`,
    );
  }
  let decoded: PaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(header);
  } catch (error) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} is not valid x402: ${messageOf(error)}`,
    );
  }
  if (!Array.isArray(decoded?.accepts)) {
    throw new TollwayError(
      "payment-failed",
      `the ${PAYMENT_REQUIRED_HEADER} header from ${resource} lists no payment options`,
    );
  }
  return decoded;
}

/**
 * The client's policy approved the offer, not whatever the 402 asks for. A
 * 402 that wants more, or pays someone else, is refused before signing.
 */
function assertMatchesOffer(
  requirements: PaymentRequirements,
  offer: SettleRequest["offer"],
  resource: string,
): void {
  if (requirements.amount !== offer.amount) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} asks for ${requirements.amount}, but the offer was ${offer.amount}`,
    );
  }
  if (requirements.payTo !== offer.payTo) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} pays ${requirements.payTo}, not the offer's payee ${offer.payTo}`,
    );
  }
  if (CONTRACT_ADDRESS.test(offer.asset) && requirements.asset !== offer.asset) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} charges asset ${requirements.asset}, not ${offer.asset}`,
    );
  }
}

function readReceipt(response: Response, resource: string): SignedReceipt {
  const header = response.headers.get(TOLLWAY_RECEIPT_HEADER);
  if (!header) {
    throw new TollwayError(
      "invalid-receipt",
      `${resource} settled the payment but sent no ${TOLLWAY_RECEIPT_HEADER} header`,
    );
  }
  let candidate: unknown;
  try {
    // Accepts standard base64 and base64url alike.
    candidate = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header)));
  } catch (error) {
    throw new TollwayError(
      "invalid-receipt",
      `the ${TOLLWAY_RECEIPT_HEADER} header from ${resource} is not base64 JSON: ${messageOf(error)}`,
    );
  }
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `the ${TOLLWAY_RECEIPT_HEADER} header from ${resource} is not a Tollway receipt`,
    );
  }
  return parsed.data;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
