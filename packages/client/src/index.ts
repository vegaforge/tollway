/**
 * @vegaforge/tollway-client
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
  comparePolicyTraces,
  createPolicyEngine,
  decisionFromTrace,
  type ModelRouter,
  type PaymentIntent,
  type PaymentOffer,
  type PolicyEngine,
  type PolicyTrace,
  type PolicyTraceComparison,
  type ReceiptVerifier,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import type { ReceiptStore } from "./receipt-store.js";

/** Events the client emits so callers and observability can follow along. */
export type ClientEvent =
  | { type: "payment"; resource: string; model: SettlementModel; receipt: SignedReceipt }
  | { type: "skip"; resource: string; reason: string }
  /**
   * The active policy's full trace for this payment, emitted before the
   * payment proceeds or is blocked. In dry-run, `trace.wouldBlock` marks a
   * payment enforce mode would have stopped. The shape is documented in
   * apps/web/src/content/docs/policy.mdx, "Decision traces".
   */
  | { type: "policy:decision"; resource: string; trace: PolicyTrace }
  /**
   * The candidate (shadow) policy's trace next to the active one, and how
   * they differ. The candidate never affects the payment.
   */
  | {
      type: "policy:shadow";
      resource: string;
      active: PolicyTrace;
      candidate: PolicyTrace;
      comparison: PolicyTraceComparison;
    }
  /** The shadow policy failed to evaluate or record. The payment is unaffected. */
  | { type: "policy:shadow-error"; resource: string; error: Error }
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
  /**
   * Optional candidate policy to evaluate next to the active one, for
   * rolling out a policy change. Its decision never blocks or allows a
   * payment: the client emits a `policy:shadow` event with both traces and
   * their differences. Settled payments are recorded on it too, so its
   * budgets count the same real spend. Shadow evaluation runs only while
   * at least one event handler is registered.
   */
  shadow?: PolicyEngine;
  /** Where construction-time warnings go. Defaults to `console`. */
  logger?: { warn(message: string): void };
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
  /**
   * Optional receipt store. When provided, every verified receipt is written
   * to it before `pay()` resolves, so the agent keeps the receipt for a
   * payment that settled.
   */
  receiptStore?: ReceiptStore;
  /**
   * Called when the receipt store fails after a payment settled. The same
   * error is set as `storeError` on the result and the receipt is still
   * returned; the payment has happened, so a bookkeeping failure must not
   * hide it. Mirrors the gate's `onCacheError`.
   */
  onStoreError?: (error: Error, receipt: SignedReceipt) => void;
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
  /**
   * Set when the payment settled but the receipt store could not persist the
   * receipt. The receipt itself is complete and valid; the store's history has
   * a hole, so treat this as an operational alert.
   */
  storeError?: Error;
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
  // With a shadow policy and no active one, the candidate is compared with
  // "no policy", which an empty policy evaluates to exactly.
  const shadowBaseline =
    options.shadow && !options.policy ? createPolicyEngine({}) : options.policy;

  if (options.policy?.mode === "dry-run") {
    // Dry-run lets through payments the policy would block. Saying so once,
    // loudly, at startup is what keeps it from being left on by accident.
    (options.logger ?? console).warn(
      "tollway-client: the policy is in dry-run mode. Payments it would block are allowed " +
        "and only reported in policy:decision events. Switch to enforce before relying on it.",
    );
  }

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

  /**
   * Evaluates the candidate next to the active policy and emits the
   * comparison. A candidate that throws (a malformed limit in a policy
   * still being drafted, say) is reported as `policy:shadow-error` rather
   * than failing the payment, because the shadow is by definition not in
   * charge of payments.
   */
  async function shadowCompare(
    shadow: PolicyEngine,
    baseline: PolicyEngine,
    activeTrace: PolicyTrace | undefined,
    intent: PaymentIntent,
    resource: string,
  ): Promise<void> {
    try {
      const active = activeTrace ?? (await baseline.evaluate(intent));
      const candidate = await shadow.evaluate(intent);
      emit({
        type: "policy:shadow",
        resource,
        active,
        candidate,
        comparison: comparePolicyTraces(active, candidate),
      });
    } catch (rawError) {
      emit({ type: "policy:shadow-error", resource, error: normalizeError(rawError) });
    }
  }

  /** Records a settled payment on the shadow; a failure is reported, not thrown. */
  async function shadowRecord(
    shadow: PolicyEngine,
    intent: PaymentIntent,
    resource: string,
  ): Promise<void> {
    try {
      await shadow.record(intent);
    } catch (rawError) {
      emit({ type: "policy:shadow-error", resource, error: normalizeError(rawError) });
    }
  }

  return {
    on(handler) {
      handlers.push(handler);
    },
    async pay(request): Promise<PayResult> {
      try {
        if (request.offer.network !== options.network) {
          throw new TollwayError(
            "network-mismatch",
            `offer network "${request.offer.network}" does not match client network "${options.network}"`,
          );
        }

        const model = await decideModel(options.router, request);
        const intent: PaymentIntent = {
          payee: request.offer.payTo,
          resource: request.resource,
          amount: request.offer.amount,
          asset: request.offer.asset,
          model,
        };

        let activeTrace: PolicyTrace | undefined;
        if (options.policy) {
          activeTrace = await options.policy.evaluate(intent);
          // No handler, no event object: the quiet path stays as cheap as a
          // plain check().
          if (handlers.length > 0) {
            emit({ type: "policy:decision", resource: request.resource, trace: activeTrace });
          }
        }

        if (options.shadow && shadowBaseline && handlers.length > 0) {
          await shadowCompare(
            options.shadow,
            shadowBaseline,
            activeTrace,
            intent,
            request.resource,
          );
        }

        if (activeTrace) {
          // The same function check() uses, so the trace just emitted and the
          // decision below cannot disagree.
          const decision = decisionFromTrace(activeTrace);
          if (!decision.allowed) {
            emit({
              type: "skip",
              resource: request.resource,
              reason: `${decision.rule}: ${decision.detail}`,
            });
            throw new PolicyBlockedError(decision.rule, decision.detail);
          }
        }

        const settled = await options.settler.settle({
          resource: request.resource,
          offer: request.offer,
          model,
        });

        // Only the parsed receipt leaves pay(), never the settler's object,
        // so a field the signature does not cover cannot reach the caller.
        const receipt = await checkedReceipt(settled, options.verifier);

        // The payment has settled, so a store failure must not cost the payer
        // the receipt. The error goes on the result and to onStoreError.
        let storeError: Error | undefined;
        if (options.receiptStore) {
          try {
            await options.receiptStore.put(receipt);
          } catch (rawStoreError) {
            storeError = normalizeError(rawStoreError);
            try {
              options.onStoreError?.(storeError, receipt);
            } catch {
              // A throwing alert hook must not poison the pay() promise either.
            }
          }
        }

        if (options.policy) {
          await options.policy.record(intent);
        }
        if (options.shadow) {
          await shadowRecord(options.shadow, intent, request.resource);
        }

        emit({ type: "payment", resource: request.resource, model, receipt });
        return storeError ? { receipt, model, storeError } : { receipt, model };
      } catch (rawError) {
        const error = normalizeError(rawError);
        emit({ type: "error", resource: request.resource, error });
        throw error;
      }
    },
  };
}
