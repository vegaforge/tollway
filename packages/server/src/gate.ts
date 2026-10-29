import {
  buildReceipt,
  canonicalJson,
  type ModelRouter,
  type MppChargePayment,
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
import type { MppChargeHandler } from "./mpp-charge.js";

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
      /**
       * Set when the payment settled but the settlement cache could not be
       * updated afterwards (the receipt write or the lock release failed).
       * The receipt is still valid; a retry of this payment may not be
       * recognised as a replay until the cache recovers.
       */
      cacheError?: Error;
    }
  | { kind: "rejected"; status: number; reason: string };

export type Gate = (request: TollwayRequest) => Promise<GateOutcome>;

export type PaywallDeps = {
  signer: ReceiptSigner;
  facilitator: FacilitatorClient;
  mppChargeHandler?: MppChargeHandler;
  router?: ModelRouter;
  cache?: SettlementCache;
  /**
   * Called when the settlement cache fails after a payment has settled. The
   * same error is also set as `cacheError` on the outcome.
   */
  onCacheError?: (error: Error, key: string) => void;
};

type Handler<TPayment> = {
  verify(input: {
    payment: TPayment;
    offer: PaymentOffer;
  }): Promise<{ valid: true; payer: string; nonce: string } | { valid: false; reason: string }>;
  settle(input: {
    payment: TPayment;
    offer: PaymentOffer;
    payer: string;
    nonce: string;
  }): Promise<{ settled: true; txHash: string } | { settled: false; reason: string }>;
};

type RejectedOutcome = Extract<GateOutcome, { kind: "rejected" }>;

/** The shared result of one settlement attempt, before it is checked against an offer. */
type SettlementResult =
  | { ok: true; receipt: SignedReceipt; replayed: boolean; cacheError?: Error }
  | { ok: false; outcome: RejectedOutcome };

type SettlementContext = {
  signer: ReceiptSigner;
  cache?: SettlementCache;
  onCacheError?: (error: Error, key: string) => void;
  /** Settlements in progress in this process, by cache key. */
  inFlight: Map<string, Promise<SettlementResult>>;
};

/**
 * How long a cross-process settlement lock lives if its holder never
 * releases it. Matches the default cache TTL.
 */
const SETTLEMENT_LOCK_TTL_MS = 30_000;

const OFFER_MISMATCH: RejectedOutcome = {
  kind: "rejected",
  status: 409,
  reason: "payment already settled for a different offer",
};

const SETTLEMENT_IN_PROGRESS: RejectedOutcome = {
  kind: "rejected",
  status: 409,
  reason: "settlement in progress",
};

/** The fields a receipt must share with the offer it is returned for. */
function offerBinding(offer: PaymentOffer, model: SettlementModel): string {
  return canonicalJson({
    model,
    network: offer.network,
    resource: offer.resource,
    amount: offer.amount,
    asset: offer.asset,
    payee: offer.payTo,
  });
}

function receiptBinding(signed: SignedReceipt): string {
  const { receipt } = signed;
  return canonicalJson({
    model: receipt.model,
    network: receipt.network,
    resource: receipt.resource,
    amount: receipt.amount,
    asset: receipt.asset,
    payee: receipt.payee,
  });
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

async function settleWithHandler<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  handler: Handler<TPayment>,
  context: SettlementContext,
): Promise<GateOutcome> {
  const verification = await handler.verify({ payment, offer });
  if (!verification.valid) {
    return { kind: "rejected", status: 402, reason: verification.reason };
  }

  // The model is part of the key because two models can derive the same
  // nonce from the same header value.
  const key = `${model}:${verification.nonce}`;

  // A request that arrives while the same payment is being settled waits for
  // that settlement instead of starting a second one. The map is read and
  // written with no await in between, so two requests cannot both miss it.
  const pending = context.inFlight.get(key);
  if (pending) {
    return toOutcome(await pending, offer, model, true);
  }

  const attempt = settleOnce(payment, offer, model, handler, verification, key, context);
  context.inFlight.set(key, attempt);
  try {
    return toOutcome(await attempt, offer, model, false);
  } finally {
    context.inFlight.delete(key);
  }
}

/**
 * Turns a settlement result into the outcome for one request. A receipt is
 * only returned for the offer it was issued against; anything else is a
 * rejection, never a replay. See docs/design.md, "Design notes" (duplicate
 * protection).
 */
function toOutcome(
  result: SettlementResult,
  offer: PaymentOffer,
  model: SettlementModel,
  waited: boolean,
): GateOutcome {
  if (!result.ok) {
    return result.outcome;
  }
  if (receiptBinding(result.receipt) !== offerBinding(offer, model)) {
    return OFFER_MISMATCH;
  }
  const outcome: GateOutcome = {
    kind: "settled",
    status: 200,
    headers: { [PAYMENT_RESPONSE_HEADER]: encodeHeader(result.receipt) },
    receipt: result.receipt,
    replayed: waited || result.replayed,
  };
  // Only the request that settled reports the cache failure; a waiter got
  // the receipt in memory, not from the cache.
  if (!waited && result.cacheError) {
    outcome.cacheError = result.cacheError;
  }
  return outcome;
}

async function settleOnce<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  handler: Handler<TPayment>,
  verification: { payer: string; nonce: string },
  key: string,
  context: SettlementContext,
): Promise<SettlementResult> {
  const { cache } = context;

  const cached = await cache?.get(key);
  if (cached) {
    return { ok: true, receipt: cached, replayed: true };
  }

  if (!cache?.acquire || !cache.release) {
    return settleAndRecord(payment, offer, model, handler, verification, key, context);
  }

  const locked = await cache.acquire(key, SETTLEMENT_LOCK_TTL_MS);
  if (!locked) {
    return { ok: false, outcome: SETTLEMENT_IN_PROGRESS };
  }

  let result: SettlementResult;
  try {
    // Another process may have settled and released between our miss and
    // our lock, so look again now that we hold it.
    const settledElsewhere = await cache.get(key);
    result = settledElsewhere
      ? { ok: true, receipt: settledElsewhere, replayed: true }
      : await settleAndRecord(payment, offer, model, handler, verification, key, context);
  } catch (error) {
    await releaseOrThrow(cache.release.bind(cache), key, error);
    throw error;
  }

  try {
    await cache.release(key);
  } catch (releaseFailure) {
    const releaseError = asError(releaseFailure, "settlement lock release failed");
    if (!result.ok || result.replayed) {
      // Nothing was settled by this request, so there is no receipt to
      // protect. Let the failure surface to the caller.
      throw releaseError;
    }
    context.onCacheError?.(releaseError, key);
    return { ...result, cacheError: result.cacheError ?? releaseError };
  }
  return result;
}

/**
 * Releases the lock after a thrown error. If the release fails as well,
 * both errors are thrown together so neither is lost.
 */
async function releaseOrThrow(
  release: (key: string) => Promise<void>,
  key: string,
  original: unknown,
): Promise<void> {
  try {
    await release(key);
  } catch (releaseFailure) {
    throw new AggregateError(
      [original, releaseFailure],
      "settlement failed and the settlement lock could not be released",
    );
  }
}

async function settleAndRecord<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  handler: Handler<TPayment>,
  verification: { payer: string; nonce: string },
  key: string,
  context: SettlementContext,
): Promise<SettlementResult> {
  const settlement = await handler.settle({
    payment,
    offer,
    payer: verification.payer,
    nonce: verification.nonce,
  });
  if (!settlement.settled) {
    return { ok: false, outcome: { kind: "rejected", status: 502, reason: settlement.reason } };
  }

  const receipt = await signReceipt(
    buildReceipt({
      payer: verification.payer,
      payee: offer.payTo,
      amount: offer.amount,
      asset: offer.asset,
      resource: offer.resource,
      model,
      settlement: { kind: "transaction", txHash: settlement.txHash },
      network: offer.network,
    }),
    context.signer,
  );

  if (!context.cache) {
    return { ok: true, receipt, replayed: false };
  }

  // The payment has settled, so a failed write must not cost the payer the
  // receipt. The error goes on the outcome and to onCacheError instead.
  try {
    await context.cache.set(key, receipt);
  } catch (writeFailure) {
    const cacheError = asError(writeFailure, "settlement cache write failed");
    context.onCacheError?.(cacheError, key);
    return { ok: true, receipt, replayed: false, cacheError };
  }
  return { ok: true, receipt, replayed: false };
}

/**
 * Builds the gate from a paywall config. It settles x402 per-request and
 * mpp-charge; a routing decision for another model is rejected rather than
 * mishandled. See docs/design.md, "Build plan", Phase 1.
 */
export function createPaywall(config: PaywallConfig, deps: PaywallDeps): Gate {
  const acceptedModels = config.models ?? ["x402"];
  const context: SettlementContext = {
    signer: deps.signer,
    cache: deps.cache,
    onCacheError: deps.onCacheError,
    inFlight: new Map(),
  };

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
      : ({ model: acceptedModels[0], reason: "default" } as const);

    if (decision.model === "x402") {
      const payment: X402Payment = { model: "x402", paymentSignature: signatureHeader };
      return settleWithHandler(payment, offer, "x402", deps.facilitator, context);
    }

    if (decision.model === "mpp-charge") {
      if (!deps.mppChargeHandler) {
        return {
          kind: "rejected",
          status: 500,
          reason: "mpp-charge handler not configured",
        };
      }

      const payment: MppChargePayment = { model: "mpp-charge", payload: signatureHeader };
      return settleWithHandler(payment, offer, "mpp-charge", deps.mppChargeHandler, context);
    }

    return {
      kind: "rejected",
      status: 501,
      reason: `model "${decision.model}" routing is selected but settlement is not implemented yet`,
    };
  };
}
