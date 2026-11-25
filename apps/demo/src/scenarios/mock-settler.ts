/**
 * A demo-local `ClientSettler` for the budget-capped scenario. It runs the
 * real x402 V2 exchange over HTTP, the same one `createX402Settler` runs in
 * live mode, but stands in a fixed transaction for the signed Stellar
 * authorization entry so a run needs no testnet, RPC, or funded account.
 *
 * The settler lives in the demo on purpose. The client package must not grow
 * a "fake" settler; #102, #184 and #185 own the real ones.
 */

import type { ClientSettler } from "@vegaforge/tollway-client";
import {
  bytesToBase64Url,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  STELLAR_EXACT_SCHEME,
  stellarCaip2,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** x402 V2, the version the gate speaks. */
const X402_VERSION = 2;

export type MockSettlerOptions = {
  /** Defaults to the global `fetch`. Inject one in tests. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Builds the settler the agent uses in mock mode. Each settlement requests the
 * resource, reads the 402, pays exactly the offer the policy approved, and
 * retries with PAYMENT-SIGNATURE. The gate answers with the resource and a
 * TOLLWAY-RECEIPT header, which this returns.
 *
 * Every payment carries a distinct transaction, because the gate's idempotency
 * key is derived from it: reusing one would look like a replay and the
 * facilitator would not be asked to verify a second time.
 */
export function createMockSettler(options: MockSettlerOptions = {}): ClientSettler {
  const doFetch = options.fetch ?? globalThis.fetch;
  let payments = 0;

  return {
    async settle({ resource, offer, model }): Promise<SignedReceipt> {
      if (model !== "x402") {
        throw new TollwayError("payment-failed", `the mock settler cannot settle model "${model}"`);
      }

      const challenge = await doFetch(resource);
      if (challenge.status !== 402) {
        throw new TollwayError(
          "payment-failed",
          `expected a 402 challenge from ${resource}, got ${challenge.status}`,
        );
      }
      const requirements = readRequirements(challenge, resource, offer.network);
      assertMatchesOffer(requirements, offer, resource);

      payments += 1;
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        accepted: requirements,
        payload: {
          transaction: bytesToBase64Url(utf8Bytes(`mock-auth-entry:${resource}:${payments}`)),
        },
      };

      const paid = await doFetch(resource, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payload) },
      });
      if (paid.status !== 200) {
        throw new TollwayError(
          "payment-failed",
          `${resource} answered the signed payment with ${paid.status}: ${await paid.text()}`,
        );
      }
      return readReceipt(paid, resource);
    },
  };
}

function readRequirements(
  response: Response,
  resource: string,
  network: StellarNetwork,
): PaymentRequirements {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!header) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no ${PAYMENT_REQUIRED_HEADER} header`,
    );
  }
  let decoded: ReturnType<typeof decodePaymentRequiredHeader>;
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
  const requirements = decoded.accepts.find(
    (option) => option.scheme === STELLAR_EXACT_SCHEME && option.network === stellarCaip2(network),
  );
  if (!requirements) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no Stellar exact option for ${stellarCaip2(network)}`,
    );
  }
  return requirements;
}

/**
 * The policy approved the offer, not whatever the 402 asks for. A challenge
 * that wants more, or pays someone else, is refused before anything is sent.
 */
function assertMatchesOffer(
  requirements: PaymentRequirements,
  offer: { amount: string; payTo: string; asset: string; network: StellarNetwork },
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
  if (requirements.asset !== offer.asset) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} charges asset ${requirements.asset}, not ${offer.asset}`,
    );
  }
  if (requirements.network !== stellarCaip2(offer.network)) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} settles on ${requirements.network}, not ${stellarCaip2(offer.network)}`,
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
  try {
    return decodeHeader<SignedReceipt>(header);
  } catch (error) {
    throw new TollwayError(
      "invalid-receipt",
      `the ${TOLLWAY_RECEIPT_HEADER} header from ${resource} is not base64 JSON: ${messageOf(error)}`,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
