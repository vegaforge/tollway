import type { PaymentOffer, SettlementModel, X402Payment } from "@tollway/core";
import { TollwayError } from "@tollway/core";
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

export type VerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

export type SettleInput = {
  payment: X402Payment;
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
 * Offline facilitator for tests and the demo. It treats any non-empty
 * payment signature as valid and derives a stable payer, nonce, and
 * transaction hash from it, so repeated runs and repeated submissions are
 * deterministic. The nonce is a hash of the signature, which makes the
 * duplicate-protection cache testable without a network.
 */
export function createMockFacilitator(): FacilitatorClient {
  return {
    async verify({ payment }) {
      if (!payment.paymentSignature) {
        return { valid: false, reason: "empty payment signature" };
      }
      return {
        valid: true,
        payer: mockAccount(payment.paymentSignature),
        nonce: mockHex(payment.paymentSignature, 32),
      };
    },
    async settle({ nonce, offer }) {
      return { settled: true, txHash: mockHex(`${nonce}:${offer.resource}`) };
    },
    async supported() {
      return { models: ["x402"], assets: [] };
    },
  };
}

/**
 * Calls a real facilitator over HTTP. The endpoint names (/verify, /settle,
 * /supported) are stable, but the exact request and response bodies belong
 * to @x402/stellar and are not pinned here.
 *
 * TODO(phase 0+): align these payloads with @x402/stellar once the wire
 * format is fixed, rather than guessing it. See docs/design.md, "What
 * Tollway is not", and the x402 facilitator reference.
 */
export function createHttpFacilitator(baseUrl: string): FacilitatorClient {
  const endpoint = (path: string) => new URL(path, baseUrl).toString();
  const notWired = (op: string) =>
    new TollwayError(
      "not-implemented",
      `HTTP facilitator ${op} is not wired to the @x402/stellar payload format yet. Run the demo with MOCK_MODE=true, or see docs/design.md.`,
    );

  return {
    async verify() {
      throw notWired("verify");
    },
    async settle() {
      throw notWired("settle");
    },
    async supported() {
      const response = await fetch(endpoint("/supported"));
      if (!response.ok) {
        throw new TollwayError(
          "payment-failed",
          `facilitator /supported returned ${response.status}`,
        );
      }
      return (await response.json()) as SupportedResult;
    },
  };
}
