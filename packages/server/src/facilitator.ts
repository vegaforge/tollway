import type { PaymentOffer, StellarNetwork, X402Payment } from "@vegaforge/tollway-core";
import { bytesToBase64Url, TollwayError, utf8Bytes } from "@vegaforge/tollway-core";
import { type FacilitatorConfig, HTTPFacilitatorClient } from "@x402/core/http";
import {
  type Network,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2, STELLAR_WILDCARD_CAIP2 } from "@x402/stellar";
import type { FacilitatorCapabilities } from "./facilitator-capabilities.js";
import { parseFacilitatorCapabilities } from "./facilitator-capabilities.js";
import { mockAccount, mockHex } from "./hash.js";

/**
 * Tollway's view of a facilitator. A facilitator verifies a signed payment
 * and settles it on chain, exposing /verify, /settle, and /supported.
 * Tollway calls one; it never is one. See docs/design.md, "What Tollway is
 * not".
 */

export type VerifyInput = {
  payment: X402Payment;
  offer: PaymentOffer;
};

/**
 * The outcome of checking a payment before settling it. A valid payment
 * carries the payer and the nonce, the idempotency key derived from the
 * signed payment.
 */
export type VerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

/** A verified x402 payment to settle, with the payer and nonce verification returned. */
export type SettleInput = {
  payment: X402Payment;
  offer: PaymentOffer;
  payer: string;
  nonce: string;
};

/** The outcome of settling: the transaction hash, or why settlement failed. */
export type SettleResult = { settled: true; txHash: string } | { settled: false; reason: string };

/**
 * The gate's view of an x402 facilitator: verify, then settle, plus a
 * capability check. {@link createHttpFacilitator} talks to a real one and
 * {@link createMockFacilitator} runs offline.
 *
 * `supported()` returns the full x402 `SupportedResponse` mapped to
 * {@link FacilitatorCapabilities} and schema-checked at the boundary so
 * callers can validate paywalls against it (Issue #155). Note that
 * `/supported` does not advertise which assets a facilitator will accept:
 * that is only confirmed by the first `/verify`.
 */
export interface FacilitatorClient {
  /**
   * The nonce `verify` would return for this payment, derived without a
   * network call, or undefined when it cannot be. The gate uses it to find a
   * settled payment in its cache before verifying: once a payment settles on
   * chain its authorization nonce is spent, so verifying a retry fails (#284).
   */
  idempotencyKey?(input: { payment: X402Payment }): Promise<string | undefined>;
  verify(input: VerifyInput): Promise<VerifyResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  supported(): Promise<FacilitatorCapabilities>;
}

/**
 * The signed Stellar transaction inside a V2 `PaymentPayload`, or undefined
 * when the payload carries none. The transaction is what the facilitator
 * verifies, and its digest is the idempotency nonce.
 */
function transactionOf(payment: X402Payment): string | undefined {
  const transaction = payment.payload.payload.transaction;
  return typeof transaction === "string" && transaction.length > 0 ? transaction : undefined;
}

/**
 * Offline facilitator for tests and the demo. Any payload with a transaction
 * is valid; payer, nonce, and tx hash are derived from it, so runs and
 * retries are deterministic with no network.
 */
export function createMockFacilitator(): FacilitatorClient {
  return {
    async idempotencyKey({ payment }) {
      const transaction = transactionOf(payment);
      return transaction ? mockHex(transaction, 32) : undefined;
    },
    async verify({ payment }) {
      const transaction = transactionOf(payment);
      if (!transaction) {
        return { valid: false, reason: "payment payload carries no transaction" };
      }
      return {
        valid: true,
        payer: mockAccount(transaction),
        nonce: mockHex(transaction, 32),
      };
    },
    async settle({ nonce, offer }) {
      return { settled: true, txHash: mockHex(`${nonce}:${offer.resource}`) };
    },
    async supported() {
      // What OpenZeppelin Channels advertises: v2 `exact` on every Stellar
      // network, with sponsored fees. The mock demo runs the same capability
      // check as the live one against it, and asset and payTo mistakes still
      // show up because validatePaywall checks those locally.
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: STELLAR_EXACT_SCHEME,
            network: STELLAR_WILDCARD_CAIP2,
            extra: { areFeesSponsored: true },
          },
        ],
        extensions: [],
        signers: {},
      };
    },
  };
}

/** The x402 scheme @x402/stellar implements; see `ExactStellarScheme.scheme`. */
export const STELLAR_EXACT_SCHEME = "exact";

/** Tollway's networks mapped to the CAIP-2 ids @x402/stellar speaks. */
const NETWORK_CAIP2: Record<StellarNetwork, Network> = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
};

/** The default for `PaymentRequirements.maxTimeoutSeconds`. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** The x402 terms an offer becomes: the timeout and the scheme's `extra` data. */
export type X402Terms = {
  /**
   * How long, in seconds, the payment stays valid. Maps to
   * `PaymentRequirements.maxTimeoutSeconds`. Defaults to 60.
   */
  maxTimeoutSeconds?: number;
  /** Scheme-specific data passed through as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
};

/**
 * Maps a Tollway network to the CAIP-2 id @x402/stellar speaks. Throws a
 * TollwayError for a network x402 has no id for, rather than guessing.
 */
export function stellarCaip2(network: StellarNetwork): Network {
  const caip2 = NETWORK_CAIP2[network];
  if (!caip2) {
    throw new TollwayError(
      "payment-failed",
      `no CAIP-2 mapping for network "${network}"; the x402 facilitator needs stellar:testnet or stellar:pubnet`,
    );
  }
  return caip2;
}

/**
 * Builds the x402 `PaymentRequirements` for an offer. The gate sends the same
 * object in its 402 challenge, so the client signs exactly what the
 * facilitator is asked to verify.
 */
export function toPaymentRequirements(
  offer: PaymentOffer,
  terms: X402Terms = {},
): PaymentRequirements {
  return {
    scheme: STELLAR_EXACT_SCHEME,
    network: stellarCaip2(offer.network),
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    maxTimeoutSeconds: terms.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    // A dynamic-price quote rides in `extra`, so the client signs it and
    // echoes it back unchanged; the facilitator ignores keys it does not read.
    extra:
      offer.quote === undefined
        ? (terms.extra ?? {})
        : { ...terms.extra, tollwayQuote: offer.quote },
  };
}

export type HttpFacilitatorOptions = X402Terms & {
  /** Per-call auth headers, for facilitators that gate /verify and /settle. */
  createAuthHeaders?: FacilitatorConfig["createAuthHeaders"];
  /**
   * Transport deadline for each request, in milliseconds. The abort signal it
   * produces closes the connection, which the gate's own deadline cannot do.
   * Defaults to the `@x402/core` client's 90 s. A `/settle` that hits it may
   * already have reached the facilitator, so the gate holds that payment
   * (see `PaywallDeps.ambiguousSettlementHoldMs`); keep the hold longer than
   * this deadline plus the authorization lifetime.
   */
  timeoutMs?: number;
};

/**
 * Calls a real facilitator over HTTP, speaking the x402 V2 wire format from
 * `@x402/core` and `@x402/stellar`. It maps Tollway's offer onto
 * `PaymentRequirements`, forwards the agent's decoded `PaymentPayload`
 * unchanged, delegates to `@x402/core`'s `HTTPFacilitatorClient`, and maps the
 * `VerifyResponse` / `SettleResponse` back to Tollway's result shapes.
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
    timeoutMs: options.timeoutMs,
  });
  const terms: X402Terms = {
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    extra: options.extra,
  };

  return {
    async idempotencyKey({ payment }) {
      const transaction = transactionOf(payment);
      return transaction ? deriveNonce(transaction) : undefined;
    },

    async verify({ payment, offer }) {
      const requirements = toPaymentRequirements(offer, terms);
      const transaction = transactionOf(payment);
      if (!transaction) {
        return { valid: false, reason: "payment payload carries no transaction" };
      }

      let response: VerifyResponse;
      try {
        // The payload arrives decoded from the gate's header parse; forward it
        // as received so the facilitator sees the agent's own `accepted` terms.
        response = await client.verify(payment.payload, requirements);
      } catch (error) {
        // A structured rejection (often a 4xx with an `isValid: false` body) is
        // a declined payment, not a transport failure: surface it as invalid.
        if (error instanceof VerifyError) {
          return {
            valid: false,
            reason: reason(error.invalidReason, error.invalidMessage, "payment rejected"),
          };
        }
        // Keep the underlying error as the cause: the failover client reads
        // it to tell a connection that was never made from one that was.
        throw new TollwayError(
          "payment-failed",
          `facilitator /verify request failed: ${message(error)}`,
          { cause: error },
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
        nonce: await deriveNonce(transaction),
      };
    },

    async settle({ payment, offer }) {
      const requirements = toPaymentRequirements(offer, terms);
      if (!transactionOf(payment)) {
        return { settled: false, reason: "payment payload carries no transaction" };
      }

      let response: SettleResponse;
      try {
        response = await client.settle(payment.payload, requirements);
      } catch (error) {
        if (error instanceof SettleError) {
          return {
            settled: false,
            reason: reason(error.errorReason, error.errorMessage, "settlement rejected"),
          };
        }
        // Keep the underlying error as the cause: the failover client reads
        // it to tell a connection that was never made from one that was.
        throw new TollwayError(
          "payment-failed",
          `facilitator /settle request failed: ${message(error)}`,
          { cause: error },
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
      let response: unknown;
      try {
        response = await client.getSupported();
      } catch (error) {
        // Keep the underlying error as the cause: the failover client reads
        // it to tell a connection that was never made from one that was.
        throw new TollwayError(
          "payment-failed",
          `facilitator /supported request failed: ${message(error)}`,
          { cause: error },
        );
      }
      // Parse at the boundary into Tollway's type. A malformed body throws
      // `facilitator-invalid-response` naming the field.
      return parseFacilitatorCapabilities(response);
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
