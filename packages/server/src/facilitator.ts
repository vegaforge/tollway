import type { MppChargePayment, PaymentOffer, SettlementModel, StellarNetwork, X402Payment } from "@tollway/core";
import { bytesToBase64Url, TollwayError, utf8Bytes } from "@tollway/core";
import { x402Version } from "@x402/core";
import { type FacilitatorConfig, HTTPFacilitatorClient } from "@x402/core/http";
import {
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  type SupportedResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import {
  type ExactStellarPayloadV2,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
} from "@x402/stellar";
import { mockAccount, mockHex } from "./hash.js";

/**
 * Tollway's view of a facilitator. A facilitator verifies a signed payment
 * and settles it on chain, exposing /verify, /settle, and /supported.
 * Tollway calls one; it never is one. See docs/design.md, "What Tollway is
 * not".
 */

export type VerifyInput = {
  payment: X402Payment | MppChargePayment;
  offer: PaymentOffer;
};

export type VerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

export type SettleInput = {
  payment: X402Payment | MppChargePayment;
  offer: PaymentOffer;
  payer: string;
  nonce: string;
};

export type SettleResult = { settled: true; txHash: string } | { settled: false; reason: string };

export type SupportedResult = {
  models: SettlementModel[];
  assets: string[];
};

export interface FacilitatorClient {
  verify(input: VerifyInput): Promise<VerifyResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  supported(): Promise<SupportedResult>;
}

/**
 * Offline facilitator for tests and the demo. Any non-empty signature is
 * valid; payer, nonce, and tx hash are derived from it, so runs and retries
 * are deterministic with no network.
 */
export function createMockFacilitator(): FacilitatorClient {
  return {
    async verify({ payment }) {
      if (payment.model === "x402") {
        if (!payment.paymentSignature) {
          return { valid: false, reason: "empty payment signature" };
        }
        return {
          valid: true,
          payer: mockAccount(payment.paymentSignature),
          nonce: mockHex(payment.paymentSignature, 32),
        };
      }
      // mpp-charge
      if (!payment.payload) {
        return { valid: false, reason: "empty mpp charge payload" };
      }
      return {
        valid: true,
        payer: mockAccount(payment.payload),
        nonce: mockHex(payment.payload, 32),
      };
    },
    async settle({ nonce, offer }) {
      return { settled: true, txHash: mockHex(`${nonce}:${offer.resource}`) };
    },
    async supported() {
      return { models: ["x402", "mpp-charge"], assets: [] };
    },
  };
}

/** The x402 scheme @x402/stellar implements; see `ExactStellarScheme.scheme`. */
const STELLAR_EXACT_SCHEME = "exact";

/** Tollway's networks mapped to the CAIP-2 ids @x402/stellar speaks. */
const NETWORK_CAIP2: Record<StellarNetwork, Network> = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
};

const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

export type HttpFacilitatorOptions = {
  /**
   * How long, in seconds, the facilitator should hold the payment valid. Maps
   * to `PaymentRequirements.maxTimeoutSeconds`. Defaults to 60.
   */
  maxTimeoutSeconds?: number;
  /** Scheme-specific data passed through as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
  /** Per-call auth headers, for facilitators that gate /verify and /settle. */
  createAuthHeaders?: FacilitatorConfig["createAuthHeaders"];
};

/**
 * Calls a real facilitator over HTTP, speaking the x402 V2 wire format from
 * `@x402/core` and `@x402/stellar`. It maps Tollway's offer and payment onto
 * `PaymentRequirements` and a `PaymentPayload` (the agent's base64 Stellar
 * transaction), delegates to `@x402/core`'s `HTTPFacilitatorClient`, and maps
 * the `VerifyResponse` / `SettleResponse` back to Tollway's result shapes.
 *
 * For offline runs use `createMockFacilitator` (MOCK_MODE in the demo).
 */
export function createHttpFacilitator(
  baseUrl: string,
  options: HttpFacilitatorOptions = {},
): FacilitatorClient {
  const client = new HTTPFacilitatorClient({
    url: baseUrl,
    createAuthHeaders: options.createAuthHeaders,
  });
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const extra = options.extra ?? {};

  function toRequirements(offer: PaymentOffer): PaymentRequirements {
    const network = NETWORK_CAIP2[offer.network];
    if (!network) {
      throw new TollwayError(
        "payment-failed",
        `no CAIP-2 mapping for network "${offer.network}"; the x402 facilitator needs stellar:testnet or stellar:pubnet`,
      );
    }
    return {
      scheme: STELLAR_EXACT_SCHEME,
      network,
      asset: offer.asset,
      amount: offer.amount,
      payTo: offer.payTo,
      maxTimeoutSeconds,
      extra,
    };
  }

  function toPayload(payment: X402Payment, requirements: PaymentRequirements): PaymentPayload {
    return {
      x402Version,
      accepted: requirements,
      // x402 V2 carries a base64 Stellar transaction envelope, not a bare signature.
      payload: { transaction: payment.paymentSignature } satisfies ExactStellarPayloadV2,
    };
  }

  return {
    async verify({ payment, offer }) {
      const requirements = toRequirements(offer);
      const payload = toPayload(payment, requirements);

      let response: VerifyResponse;
      try {
        response = await client.verify(payload, requirements);
      } catch (error) {
        // A structured rejection (often a 4xx with an `isValid: false` body) is
        // a declined payment, not a transport failure: surface it as invalid.
        if (error instanceof VerifyError) {
          return {
            valid: false,
            reason: reason(error.invalidReason, error.invalidMessage, "payment rejected"),
          };
        }
        throw new TollwayError(
          "payment-failed",
          `facilitator /verify request failed: ${message(error)}`,
        );
      }

      if (!response.isValid) {
        return {
          valid: false,
          reason: reason(response.invalidReason, response.invalidMessage, "payment rejected"),
        };
      }
      if (!response.payer) {
        return { valid: false, reason: "facilitator verified the payment but returned no payer" };
      }
      return {
        valid: true,
        payer: response.payer,
        nonce: await deriveNonce(payment.paymentSignature),
      };
    },

    async settle({ payment, offer }) {
      const requirements = toRequirements(offer);
      const payload = toPayload(payment, requirements);

      let response: SettleResponse;
      try {
        response = await client.settle(payload, requirements);
      } catch (error) {
        if (error instanceof SettleError) {
          return {
            settled: false,
            reason: reason(error.errorReason, error.errorMessage, "settlement rejected"),
          };
        }
        throw new TollwayError(
          "payment-failed",
          `facilitator /settle request failed: ${message(error)}`,
        );
      }

      if (!response.success) {
        return {
          settled: false,
          reason: reason(response.errorReason, response.errorMessage, "settlement rejected"),
        };
      }
      return { settled: true, txHash: response.transaction };
    },

    async supported() {
      let response: SupportedResponse;
      try {
        response = await client.getSupported();
      } catch (error) {
        throw new TollwayError(
          "payment-failed",
          `facilitator /supported request failed: ${message(error)}`,
        );
      }
      // x402 /supported advertises (scheme, network) kinds, not an asset list.
      const models: SettlementModel[] = response.kinds.some(
        (kind) => kind.scheme === STELLAR_EXACT_SCHEME,
      )
        ? ["x402"]
        : [];
      return { models, assets: [] };
    },
  };
}

/** First non-empty reason, falling back to a generic message. */
function reason(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return "unknown reason";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A stable idempotency key for a payment. The signed transaction envelope is
 * unique per payment, so its SHA-256 digest dedupes retries of the same
 * payment without leaking the envelope into cache keys or logs.
 */
async function deriveNonce(transaction: string): Promise<string> {
  const data = new Uint8Array(utf8Bytes(transaction));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
}
