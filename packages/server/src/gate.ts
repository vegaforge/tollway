import {
  buildReceipt,
  type ModelRouter,
  type PaymentOffer,
  type ReceiptSigner,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signReceipt,
  type X402Payment,
} from "@tollway/core";
import type { SettlementCache } from "./cache.js";
import type { FacilitatorClient } from "./facilitator.js";
import {
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
} from "./headers.js";

/**
 * The gating molecule. It sits between a request and the resource: with a
 * valid payment it settles and lets the request through, without one it
 * answers 402 with the right challenge. Switching models is configuration,
 * not a rewrite. See docs/design.md, "Design notes" (the gating molecule).
 */

export type TollwayRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
};

/** What the service charges for a resource. */
export type PaywallConfig = {
  /** Price as an integer string in the asset's smallest unit. */
  amount: string;
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  /** Accepted models, in order of preference. Defaults to x402 only. */
  models?: SettlementModel[];
  /** Overrides the request URL as the resource identifier in the receipt. */
  resource?: string;
  facilitatorUrl?: string;
};

export type PaywallDeps = {
  signer: ReceiptSigner;
  facilitator: FacilitatorClient;
  router?: ModelRouter;
  cache?: SettlementCache;
};

export type GateOutcome =
  | {
      kind: "payment-required";
      status: 402;
      headers: Record<string, string>;
      challenge: PaymentOffer;
    }
  | {
      kind: "settled";
      status: 200;
      headers: Record<string, string>;
      receipt: SignedReceipt;
      /** True when the receipt came from the idempotency cache, not a fresh settlement. */
      replayed: boolean;
    }
  | { kind: "rejected"; status: number; reason: string };

export type Gate = (request: TollwayRequest) => Promise<GateOutcome>;

/**
 * Builds the gate from a paywall config. It settles x402 per-request today; a
 * routing decision for another model is rejected rather than mishandled.
 *
 * TODO: settle MPP charge and channel once their packages can. See
 * docs/design.md, "Build plan".
 */
export function createPaywall(config: PaywallConfig, deps: PaywallDeps): Gate {
  const acceptedModels = config.models ?? ["x402"];

  return async function gate(request): Promise<GateOutcome> {
    const offer: PaymentOffer = {
      resource: config.resource ?? request.url,
      amount: config.amount,
      asset: config.asset,
      payTo: config.payTo,
      network: config.network,
      models: acceptedModels,
      facilitatorUrl: config.facilitatorUrl,
    };

    const signatureHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    if (!signatureHeader) {
      return {
        kind: "payment-required",
        status: 402,
        headers: { [PAYMENT_REQUIRED_HEADER]: encodeHeader(offer) },
        challenge: offer,
      };
    }

    const decision = deps.router
      ? await deps.router.decide({ counterparty: offer.payTo, resource: offer.resource, offer })
      : ({ model: "x402", reason: "default" } as const);

    if (decision.model !== "x402") {
      return {
        kind: "rejected",
        status: 501,
        reason: `model "${decision.model}" routing is selected but settlement is not implemented yet`,
      };
    }

    const payment: X402Payment = { model: "x402", paymentSignature: signatureHeader };

    const verification = await deps.facilitator.verify({ payment, offer });
    if (!verification.valid) {
      return { kind: "rejected", status: 402, reason: verification.reason };
    }

    const cached = await deps.cache?.get(verification.nonce);
    if (cached) {
      return {
        kind: "settled",
        status: 200,
        headers: { [PAYMENT_RESPONSE_HEADER]: encodeHeader(cached) },
        receipt: cached,
        replayed: true,
      };
    }

    const settlement = await deps.facilitator.settle({
      payment,
      offer,
      payer: verification.payer,
      nonce: verification.nonce,
    });
    if (!settlement.settled) {
      return { kind: "rejected", status: 502, reason: settlement.reason };
    }

    const receipt = await signReceipt(
      buildReceipt({
        payer: verification.payer,
        payee: offer.payTo,
        amount: offer.amount,
        asset: offer.asset,
        resource: offer.resource,
        model: "x402",
        settlement: { kind: "transaction", txHash: settlement.txHash },
        network: offer.network,
      }),
      deps.signer,
    );

    // Awaiting set ensures a peer process or retry on this process cannot
    // race past the cache write and double-settle. The trade-off: a cache
    // failure after on-chain settlement bubbles up and the retry triggers a
    // second settle (the agent has paid but lost the receipt). Surfacing
    // that failure via the observability hub and swallowing the error in
    // the gate is tracked as a follow-up.
    await deps.cache?.set(verification.nonce, receipt);

    return {
      kind: "settled",
      status: 200,
      headers: { [PAYMENT_RESPONSE_HEADER]: encodeHeader(receipt) },
      receipt,
      replayed: false,
    };
  };
}
