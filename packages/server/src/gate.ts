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
} from "@vegaforge/tollway-core";
import type { SettlementCache, SettlementLock } from "./cache.js";
import type { FacilitatorClient } from "./facilitator.js";
import {
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
  readMppCredential,
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
      /**
       * Set when this request settled but did not hold the cross-process
       * settlement lock for the whole settlement (it expired or could not
       * be renewed). Another process may have settled the same payment, so
       * treat it as an operational alert. `cacheError` explains why.
       */
      lockLost?: true;
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
  /**
   * How long a cross-process settlement lock lives if its holder stops
   * renewing it, in milliseconds. Defaults to 30 000. Only used with a cache
   * that implements locks.
   */
  settlementLockTtlMs?: number;
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
  | {
      ok: true;
      receipt: SignedReceipt;
      replayed: boolean;
      /** Method of the request this receipt was settled for; null if unknown. */
      method: string | null;
      cacheError?: Error;
      lockLost?: true;
    }
  | { ok: false; outcome: RejectedOutcome };

type SettlementContext = {
  signer: ReceiptSigner;
  cache?: SettlementCache;
  onCacheError?: (error: Error, key: string) => void;
  /** Settlements in progress in this process, by cache key. */
  inFlight: Map<string, Promise<SettlementResult>>;
  lockTtlMs: number;
};

/**
 * How long a cross-process settlement lock lives if its holder never
 * releases it. Matches the default cache TTL.
 */
const DEFAULT_SETTLEMENT_LOCK_TTL_MS = 30_000;

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
  method: string,
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
    return toOutcome(await pending, offer, model, method, true);
  }

  const attempt = settleOnce(payment, offer, model, method, handler, verification, key, context);
  context.inFlight.set(key, attempt);
  try {
    return toOutcome(await attempt, offer, model, method, false);
  } finally {
    context.inFlight.delete(key);
  }
}

/**
 * Turns a settlement result into the outcome for one request. A receipt is
 * only returned for the offer it was issued against, and for the HTTP method
 * it was paid with; anything else is a rejection, never a replay. See
 * docs/design.md, "Design notes" (duplicate protection).
 */
function toOutcome(
  result: SettlementResult,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  waited: boolean,
): GateOutcome {
  if (!result.ok) {
    return result.outcome;
  }
  // A null method comes from an entry an older version wrote. Refusing it
  // is safe; treating it as a miss would settle the payment a second time.
  if (result.method !== method) {
    return OFFER_MISMATCH;
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
  if (!waited && result.lockLost) {
    outcome.lockLost = true;
  }
  return outcome;
}

async function settleOnce<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  handler: Handler<TPayment>,
  verification: { payer: string; nonce: string },
  key: string,
  context: SettlementContext,
): Promise<SettlementResult> {
  const { cache } = context;

  const cached = await cache?.get(key);
  if (cached) {
    return { ok: true, receipt: cached.receipt, method: cached.method, replayed: true };
  }

  if (!cache?.acquire || !cache.release || !cache.renew) {
    return settleAndRecord(payment, offer, model, method, handler, verification, key, context);
  }

  const lock = await cache.acquire(key, context.lockTtlMs);
  if (!lock) {
    return { ok: false, outcome: SETTLEMENT_IN_PROGRESS };
  }
  const release = (): Promise<boolean> => cache.release?.(key, lock) ?? Promise.resolve(false);

  // A slow facilitator can outlive the lock TTL, and an expired lock lets a
  // second process settle the same payment. Renew it while we work.
  const keeper = keepLockAlive(cache.renew.bind(cache), key, lock, context.lockTtlMs);

  let result: SettlementResult;
  try {
    // Another process may have settled and released between our miss and
    // our lock, so look again now that we hold it.
    const settledElsewhere = await cache.get(key);
    result = settledElsewhere
      ? {
          ok: true,
          receipt: settledElsewhere.receipt,
          method: settledElsewhere.method,
          replayed: true,
        }
      : await settleAndRecord(payment, offer, model, method, handler, verification, key, context);
  } catch (error) {
    keeper.stop();
    await releaseOrThrow(release, key, error);
    throw error;
  }
  keeper.stop();

  let released: boolean;
  try {
    released = await release();
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

  // The lock was not ours for the whole settlement, so another process may
  // have settled this payment too. The receipt is still valid; say so loudly.
  if (result.ok && !result.replayed && (keeper.lost() || !released)) {
    const lostError = keeper.error() ?? new Error(LOCK_LOST_MESSAGE);
    context.onCacheError?.(lostError, key);
    return { ...result, lockLost: true, cacheError: result.cacheError ?? lostError };
  }
  return result;
}

/**
 * A cache with only some of the lock methods would silently settle without a
 * lock (or with one nobody renews), so refuse it at construction.
 */
function assertCompleteLocking(cache: SettlementCache | undefined): void {
  if (!cache) return;
  const present = [cache.acquire, cache.renew, cache.release].filter(Boolean).length;
  if (present !== 0 && present !== 3) {
    throw new TypeError(
      "the settlement cache must implement all of acquire, renew and release, or none of them",
    );
  }
}

const LOCK_LOST_MESSAGE =
  "the settlement lock was lost before the settlement finished, so duplicate protection across processes was not held throughout";

type LockKeeper = { stop(): void; lost(): boolean; error(): Error | undefined };

/**
 * Renews a held lock every third of its TTL until stopped. A renewal that
 * reports the lock is gone, or that fails, marks the lock as lost; it never
 * throws into the request. The timer does not keep the process alive.
 */
function keepLockAlive(
  renew: (key: string, lock: SettlementLock, ttlMs: number) => Promise<boolean>,
  key: string,
  lock: SettlementLock,
  ttlMs: number,
): LockKeeper {
  let stopped = false;
  let lost = false;
  let failure: Error | undefined;
  const timer = setInterval(
    () => {
      renew(key, lock, ttlMs).then(
        (held) => {
          if (!stopped && !held) lost = true;
        },
        (renewFailure: unknown) => {
          if (stopped) return;
          lost = true;
          failure = asError(renewFailure, "settlement lock renewal failed");
        },
      );
    },
    Math.max(1, Math.floor(ttlMs / 3)),
  );
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    lost: () => lost,
    error: () => failure,
  };
}

/**
 * Releases the lock after a thrown error. If the release fails as well,
 * both errors are thrown together so neither is lost.
 */
async function releaseOrThrow(
  release: () => Promise<boolean>,
  key: string,
  original: unknown,
): Promise<void> {
  try {
    await release();
  } catch (releaseFailure) {
    throw new AggregateError(
      [original, releaseFailure],
      `settlement failed and the settlement lock for ${key} could not be released`,
    );
  }
}

async function settleAndRecord<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
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
    return { ok: true, receipt, method, replayed: false };
  }

  // The payment has settled, so a failed write must not cost the payer the
  // receipt. The error goes on the outcome and to onCacheError instead.
  try {
    await context.cache.set(key, { receipt, method });
  } catch (writeFailure) {
    const cacheError = asError(writeFailure, "settlement cache write failed");
    context.onCacheError?.(cacheError, key);
    return { ok: true, receipt, method, replayed: false, cacheError };
  }
  return { ok: true, receipt, method, replayed: false };
}

/**
 * The 402 for a request with no payment. It always carries the x402
 * PAYMENT-REQUIRED header. When the route accepts mpp-charge, the MPP
 * challenge `mppx` built (its `WWW-Authenticate: Payment ...` header) is
 * added alongside, so an agent can answer with either protocol.
 */
async function paymentRequired(
  offer: PaymentOffer,
  request: TollwayRequest,
  acceptedModels: SettlementModel[],
  mppChargeHandler: MppChargeHandler | undefined,
): Promise<GateOutcome> {
  const headers: Record<string, string> = { [PAYMENT_REQUIRED_HEADER]: encodeHeader(offer) };
  if (acceptedModels.includes("mpp-charge") && mppChargeHandler?.challenge) {
    const mpp = await mppChargeHandler.challenge({
      offer,
      request: { method: request.method, url: request.url },
    });
    Object.assign(headers, mpp.headers);
  }
  return { kind: "payment-required", status: 402, headers, challenge: offer };
}

/**
 * Builds the gate from a paywall config. It settles x402 per-request and
 * mpp-charge; a routing decision for another model is rejected rather than
 * mishandled. See docs/design.md, "Build plan", Phase 1.
 */
export function createPaywall(config: PaywallConfig, deps: PaywallDeps): Gate {
  assertCompleteLocking(deps.cache);
  const acceptedModels = config.models ?? ["x402"];
  const context: SettlementContext = {
    signer: deps.signer,
    cache: deps.cache,
    onCacheError: deps.onCacheError,
    inFlight: new Map(),
    lockTtlMs: deps.settlementLockTtlMs ?? DEFAULT_SETTLEMENT_LOCK_TTL_MS,
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

    const method = request.method.toUpperCase();
    const signatureHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    const mppCredential = acceptedModels.includes("mpp-charge")
      ? readMppCredential(request.headers)
      : undefined;

    // An MPP credential answers an MPP challenge, so the agent has already
    // chosen the model; the router is not asked again.
    if (mppCredential) {
      if (!deps.mppChargeHandler) {
        return {
          kind: "rejected",
          status: 500,
          reason: "mpp-charge handler not configured",
        };
      }
      const payment: MppChargePayment = { model: "mpp-charge", payload: mppCredential };
      return settleWithHandler(
        payment,
        offer,
        "mpp-charge",
        method,
        deps.mppChargeHandler,
        context,
      );
    }

    if (!signatureHeader) {
      return paymentRequired(offer, request, acceptedModels, deps.mppChargeHandler);
    }

    const decision = deps.router
      ? await deps.router.decide({ counterparty: offer.payTo, resource: offer.resource, offer })
      : ({ model: acceptedModels[0], reason: "default" } as const);

    if (decision.model === "x402") {
      const payment: X402Payment = { model: "x402", paymentSignature: signatureHeader };
      return settleWithHandler(payment, offer, "x402", method, deps.facilitator, context);
    }

    if (decision.model === "mpp-charge") {
      return {
        kind: "rejected",
        status: 400,
        reason:
          "mpp-charge payments carry an Authorization: Payment credential, not PAYMENT-SIGNATURE",
      };
    }

    return {
      kind: "rejected",
      status: 501,
      reason: `model "${decision.model}" routing is selected but settlement is not implemented yet`,
    };
  };
}
