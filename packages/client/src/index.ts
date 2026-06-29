/**
 * @tollway/client
 *
 * The agent-side wrapper. One call to pay for a resource: the client runs
 * the policy check, asks the router which model to use, delegates the
 * actual signing and submission to an injected `ClientSettler`, verifies
 * the returned receipt (if a verifier is configured), records the
 * settlement on the policy engine so budgets advance, and hands back the
 * canonical receipt. See docs/design.md, "Architecture" (agent side).
 *
 * The settler is the seam between this orchestrator and the protocol-
 * specific dance (Soroban auth entry signing for x402, MPP channel
 * commitments, etc.). Tests inject a mock settler; production wires a
 * settler backed by @x402/stellar (and later @stellar/mpp). Keeping the
 * settler injected means the client itself stays pure orchestration and
 * the test surface is small.
 */

import {
  type ModelRouter,
  type PaymentIntent,
  type PaymentOffer,
  type PolicyEngine,
  type ReceiptVerifier,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
  verifyReceipt,
} from "@tollway/core";

/** Events the client emits so callers and observability can follow along. */
export type ClientEvent =
  | { type: "payment"; resource: string; model: SettlementModel; receipt: SignedReceipt }
  | { type: "skip"; resource: string; reason: string }
  | { type: "error"; resource: string; error: Error }
  | { type: "budget:warning"; remaining: string }
  | { type: "channel:opened"; channelId: string }
  | { type: "channel:closed"; channelId: string };

export type ClientEventHandler = (event: ClientEvent) => void;

/**
 * The agent-side analog of the server's `FacilitatorClient`. Given a
 * routed offer, the settler runs the protocol-specific flow (sign + post
 * for x402, channel commitment for mpp-channel, etc.) and returns the
 * canonical receipt the service handed back. The client itself does not
 * speak HTTP or sign authorizations; that work lives behind this seam.
 */
export interface ClientSettler {
  settle(input: SettleRequest): Promise<SignedReceipt>;
}

export type SettleRequest = {
  resource: string;
  offer: PaymentOffer;
  model: SettlementModel;
};

export type TollwayClientOptions = {
  network: StellarNetwork;
  /** The protocol-specific signer / submitter for an offer. */
  settler: ClientSettler;
  /** Optional policy engine. When omitted, every payment is allowed. */
  policy?: PolicyEngine;
  /** Optional router. When omitted, defaults to x402 unless `model` is on the request. */
  router?: ModelRouter;
  /**
   * Optional verifier. When provided, the returned receipt is checked
   * against the verifier's trusted public keys before `pay()` resolves;
   * a tampered or unknown-key receipt produces a `TollwayError` with
   * code `"receipt-verification-failed"`. Recommended in production: the
   * receipt is the service's signature, and skipping verification leaves
   * a tampered receipt undetected on the agent side.
   */
  verifier?: ReceiptVerifier;
  /** Default facilitator URL when an offer does not name one. */
  facilitatorUrl?: string;
};

export type PayRequest = {
  /** The resource URL to pay for. */
  resource: string;
  /** The offer read from the 402 challenge. */
  offer: PaymentOffer;
  /** Force a settlement model, bypassing the router. */
  model?: SettlementModel;
};

export type PayResult = {
  receipt: SignedReceipt;
  model: SettlementModel;
};

export interface TollwayClient {
  pay(request: PayRequest): Promise<PayResult>;
  on(handler: ClientEventHandler): void;
}

/**
 * Wires the agent-side x402 flow. The orchestrator does not import
 * @x402/stellar directly; the SDK call lives behind the injected
 * settler so the client stays pure orchestration. MPP charge and
 * channel modes plug into the same shape once their settlers exist.
 */
export function createClient(options: TollwayClientOptions): TollwayClient {
  const handlers: ClientEventHandler[] = [];

  function emit(event: ClientEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // A bad handler must not poison the pay() promise. Observability
        // pipelines wire their own retry/log strategy; this is best-effort.
      }
    }
  }

  return {
    on(handler) {
      handlers.push(handler);
    },
    async pay(request): Promise<PayResult> {
      try {
        const model = await decideModel(options.router, request);
        const intent: PaymentIntent = {
          payee: request.offer.payTo,
          resource: request.resource,
          amount: request.offer.amount,
          asset: request.offer.asset,
          model,
        };

        if (options.policy) {
          const decision = await options.policy.check(intent);
          if (!decision.allowed) {
            emit({
              type: "skip",
              resource: request.resource,
              reason: `${decision.rule}: ${decision.detail}`,
            });
            throw new PolicyBlockedError(decision.rule, decision.detail);
          }
        }

        const receipt = await options.settler.settle({
          resource: request.resource,
          offer: request.offer,
          model,
        });

        if (options.verifier) {
          const verification = await verifyReceipt(receipt, options.verifier);
          if (!verification.valid) {
            throw new ReceiptVerificationError(verification.reason);
          }
        }

        if (options.policy) {
          await options.policy.record(intent);
        }

        emit({ type: "payment", resource: request.resource, model, receipt });
        return { receipt, model };
      } catch (rawError) {
        const error = normalizeError(rawError);
        emit({ type: "error", resource: request.resource, error });
        throw error;
      }
    },
  };
}

/**
 * Thrown when the policy engine blocks a payment before settlement.
 * Extends `TollwayError` with code `"policy-blocked"` so a caller branching
 * on `error.code` across Tollway picks this up uniformly with the rest of
 * the typed errors. `rule` and `detail` carry the specific policy decision
 * so the caller can branch on the rule that fired (budget, per-service,
 * rate-limit, etc.).
 */
export class PolicyBlockedError extends TollwayError {
  readonly rule: string;
  readonly detail: string;
  constructor(rule: string, detail: string) {
    super("policy-blocked", `policy blocked payment: ${rule} (${detail})`);
    this.name = "PolicyBlockedError";
    this.rule = rule;
    this.detail = detail;
  }
}

/**
 * Thrown when the returned receipt fails verification against the
 * configured verifier. Extends `TollwayError` with code
 * `"receipt-verification-failed"` so it composes with the rest of the
 * typed-error model; `reason` carries the underlying verifier message
 * (schema mismatch, signature did not verify, unknown key, etc.).
 */
export class ReceiptVerificationError extends TollwayError {
  readonly reason: string;
  constructor(reason: string) {
    super("receipt-verification-failed", `receipt failed verification: ${reason}`);
    this.name = "ReceiptVerificationError";
    this.reason = reason;
  }
}

async function decideModel(
  router: ModelRouter | undefined,
  request: PayRequest,
): Promise<SettlementModel> {
  if (request.model) return request.model;
  if (!router) return "x402";
  const decision = await router.decide({
    counterparty: request.offer.payTo,
    resource: request.resource,
    offer: request.offer,
  });
  return decision.model;
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}
