import {
  base64UrlToBytes,
  buildReceipt,
  bytesToBase64Url,
  canonicalJson,
  hashOffer,
  type ModelRouter,
  type MppChargePayment,
  type PaymentOffer,
  type ReceiptSigner,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signReceipt,
  TollwayError,
  utf8Bytes,
  type X402Payment,
} from "@vegaforge/tollway-core";
import { x402Version } from "@x402/core";
import type { PaymentRequired, PaymentPayload as X402Payload } from "@x402/core/types";
import type { DeclareDiscoveryExtensionInput } from "@x402/extensions/bazaar";
import { declareDiscoveryExtension, validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import type { SettlementCache, SettlementLock } from "./cache.js";
import { type FacilitatorClient, stellarCaip2, toPaymentRequirements } from "./facilitator.js";
import {
  decodePaymentSignatureHeader,
  encodeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  readHeader,
  readMppCredential,
  TOLLWAY_QUOTE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./headers.js";
import type { MppChargeHandler } from "./mpp-charge.js";
import {
  createInMemoryServicePolicyStore,
  SERVICE_POLICY_DENIALS,
  type ServicePolicy,
  type ServicePolicyDecision,
  type ServicePolicyReservation,
  type ServicePolicyStore,
  validateServicePolicy,
} from "./service-policy.js";

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

export type DynamicPriceFunction = (request: TollwayRequest) => string | Promise<string>;

/** What the service charges for a resource. */
export type PaywallConfig = {
  /** Price as an integer string in the asset's smallest unit. */
  amount: string | DynamicPriceFunction;
  /** Required bounds for a dynamic price function. */
  minAmount?: string;
  maxAmount?: string;
  /** Secret used to authenticate dynamic-price quotes. */
  quoteSecret?: string;
  /**
   * Secrets from before a rotation. Quotes signed with them are still
   * accepted until they expire; new quotes are always signed with
   * `quoteSecret`. Drop an old secret once its quotes have expired.
   */
  previousQuoteSecrets?: readonly string[];
  /** Quote validity in seconds. Defaults to 60. */
  quoteTtlSeconds?: number;
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  /** Accepted models, in order of preference. Defaults to x402 only. */
  models?: SettlementModel[];
  /** Overrides the request URL as the resource identifier in the receipt. */
  resource?: string;
  facilitatorUrl?: string;
  /** x402: how long the payment stays valid, in seconds. Defaults to 60. */
  maxTimeoutSeconds?: number;
  /** x402: scheme-specific data, sent as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
  /**
   * Issue #154: x402 Bazaar discovery. When set, `createPaywall` declares
   * the route for Bazaar catalogues via `@x402/extensions`:
   * `extensions.bazaar` is added to the `PaymentRequired` challenge and
   * carried on the payload forwarded to `/verify` and `/settle` so a
   * cataloguing facilitator can extract it with `extractDiscoveryInfo`.
   * Routes without this block behave exactly as today and publish
   * nothing.
   */
  discovery?: DiscoveryDeclaration;
};

/**
 * The route-level discovery declaration (Issue #154). A query route uses
 * `kind: "query"` with query-string `input`; a body route uses
 * `kind: "body"` with a `bodyType`. Route templates must not leak path
 * parameters that identify a user (use `:param` templates). The service
 * description and tags, if set, are validated by `@x402/extensions`
 * before they land on a 402.
 */
export type DiscoveryDeclaration =
  | {
      kind: "query";
      input?: Record<string, unknown>;
      inputSchema?: Record<string, unknown>;
      pathParams?: Record<string, unknown>;
      pathParamsSchema?: Record<string, unknown>;
      output?: { example?: unknown; schema?: Record<string, unknown> };
    }
  | {
      kind: "body";
      bodyType: "json" | "form-data" | "text";
      input?: Record<string, unknown>;
      inputSchema?: Record<string, unknown>;
      pathParams?: Record<string, unknown>;
      pathParamsSchema?: Record<string, unknown>;
      output?: { example?: unknown; schema?: Record<string, unknown> };
    };

/**
 * What the gate decided for one request: a 402 with the challenge, a settled
 * payment with its receipt, or a rejection. Adapters turn it into their
 * framework's response.
 */
export type GateOutcome =
  | {
      kind: "payment-required";
      status: 402;
      headers: Record<string, string>;
      /** The x402 V2 `PaymentRequired`, also sent as the 402's JSON body. */
      challenge: PaymentRequired;
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
  | {
      kind: "rejected";
      status: number;
      /** A stable reason code, or a human message when no code applies. */
      reason: string;
      /** Headers the adapter must send with the rejection, such as `Retry-After`. */
      headers?: Record<string, string>;
    };

/** A payment gate for one paid resource, built by {@link createPaywall}. */
export type Gate = (request: TollwayRequest) => Promise<GateOutcome>;

/**
 * The services a gate uses: the receipt signer, the facilitator, and the
 * optional MPP charge handler, router and settlement cache.
 */
export type PaywallDeps = {
  signer: ReceiptSigner;
  facilitator: FacilitatorClient;
  mppChargeHandler?: MppChargeHandler;
  router?: ModelRouter;
  cache?: SettlementCache;
  /**
   * Optional per-payer rules evaluated after `/verify` and before the
   * settlement lock. A denial is rejected without calling `/settle`. See
   * `ServicePolicy` and docs/design.md, "Policy and budgets".
   */
  servicePolicy?: ServicePolicy;
  /**
   * Where the service policy keeps per-payer windows. Defaults to a
   * per-gate in-memory store bounded to 10 000 payers, with least-recently-used
   * eviction. Inject a shared store for multiple processes; the in-memory
   * limits only hold within one process (#190).
   */
  servicePolicyStore?: ServicePolicyStore;
  /**
   * Called when the service policy store fails to record or release a
   * reservation. The payment's outcome is unchanged: a settled payment still
   * returns its receipt, and a settlement error is still thrown. The payer's
   * counters may be off until the window rolls over.
   */
  onServicePolicyError?: (error: Error, payer: string) => void;
  /**
   * Called when the settlement cache fails after a payment has settled. The
   * same error is also set as `cacheError` on the outcome.
   */
  onCacheError?: (error: Error, key: string) => void;
  /**
   * Called when a dynamic price function throws. The request is rejected
   * with 500 and nothing is charged; the error goes here, not to the agent.
   */
  onPriceError?: (error: unknown, request: TollwayRequest) => void;
  /**
   * How long a cross-process settlement lock lives if its holder stops
   * renewing it, in milliseconds. Defaults to 30 000. Only used with a cache
   * that implements locks.
   */
  settlementLockTtlMs?: number;
  /** Clock for quote expiry and service policy windows; injected tests can avoid waiting. */
  clock?: () => number;
  /**
   * The receipt version this gate issues (Issue #166). Defaults to 1.
   *
   * Version 2 adds `offerHash`, `method` and an optional `expiresAt`, so a
   * receipt names the exact offer the payer accepted. A process from before
   * #166 reads a cached v2 receipt as a cache miss and would settle the
   * payment again, so switch in this order: deploy this version everywhere
   * with `receiptVersion` unset, wait until no older process serves traffic
   * or shares the settlement cache, then set `receiptVersion: 2`. Cached v1
   * receipts keep being served after the switch. See docs/receipt-format.md,
   * "Receipt v2".
   */
  receiptVersion?: 1 | 2;
};

type Handler<TPayment> = {
  idempotencyKey?(input: { payment: TPayment }): Promise<string | undefined>;
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

type QuotePayload = {
  version: 1;
  id: string;
  resource: string;
  amount: string;
  expiresAt: number;
};

const DEFAULT_QUOTE_TTL_SECONDS = 60;
const INTEGER_AMOUNT = /^[0-9]+$/;

function parsePriceAmount(value: string, field: string): bigint {
  if (typeof value !== "string" || !INTEGER_AMOUNT.test(value)) {
    throw new TollwayError("invalid-amount", `${field} must be a non-negative integer string`);
  }
  return BigInt(value);
}

function quoteBytes(payload: QuotePayload): ArrayBuffer {
  const bytes = new Uint8Array(utf8Bytes(JSON.stringify(payload)));
  return bytes.buffer;
}

function isQuotePayload(value: unknown): value is QuotePayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.resource === "string" &&
    typeof candidate.amount === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

async function quoteMac(payload: QuotePayload, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(utf8Bytes(secret)).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, quoteBytes(payload))),
  );
}

async function createQuote(
  resource: string,
  amount: string,
  now: number,
  ttlSeconds: number,
  secret: string,
): Promise<string> {
  const payload: QuotePayload = {
    version: 1,
    id: crypto.randomUUID(),
    resource,
    amount,
    expiresAt: now + ttlSeconds * 1000,
  };
  const encoded = bytesToBase64Url(utf8Bytes(JSON.stringify(payload)));
  return `${encoded}.${await quoteMac(payload, secret)}`;
}

/**
 * Reads a quote token. Returns the payload when its MAC matches one of the
 * secrets and it names this resource, with `expired` set when its lifetime
 * is over; the caller decides what an expired quote may still do. Anything
 * malformed, forged or for another resource is undefined.
 */
async function readQuote(
  token: string,
  resource: string,
  now: number,
  secrets: readonly string[],
): Promise<{ payload: QuotePayload; expired: boolean } | undefined> {
  const [encoded, mac, ...rest] = token.split(".");
  if (!encoded || !mac || rest.length !== 0) return undefined;
  let payload: QuotePayload;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    if (!isQuotePayload(decoded)) return undefined;
    payload = decoded;
  } catch {
    return undefined;
  }
  if (
    payload.version !== 1 ||
    typeof payload.id !== "string" ||
    payload.resource !== resource ||
    !INTEGER_AMOUNT.test(payload.amount) ||
    !Number.isSafeInteger(payload.expiresAt)
  ) {
    return undefined;
  }
  for (const secret of secrets) {
    if (sameMac(await quoteMac(payload, secret), mac)) {
      return { payload, expired: payload.expiresAt < now };
    }
  }
  return undefined;
}

/** Compares two MACs without stopping at the first differing character. */
function sameMac(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return mismatch === 0;
}

/** The secrets a quote may be signed with: the current one first. */
function quoteSecrets(config: PaywallConfig): string[] {
  return [config.quoteSecret ?? "", ...(config.previousQuoteSecrets ?? [])];
}

/** The quote an x402 payment echoes in `accepted.extra.tollwayQuote`, if any. */
function quoteFromPayload(payment: X402Payload): string | undefined {
  const value = payment.accepted.extra?.tollwayQuote;
  return typeof value === "string" ? value : undefined;
}

function validateDynamicPriceConfig(config: PaywallConfig): void {
  if (typeof config.amount !== "function") return;
  if (config.minAmount == null || config.maxAmount == null || !config.quoteSecret) {
    throw new TollwayError(
      "invalid-policy",
      "dynamic pricing requires minAmount, maxAmount, and quoteSecret",
    );
  }
  const min = parsePriceAmount(config.minAmount, "minAmount");
  const max = parsePriceAmount(config.maxAmount, "maxAmount");
  if (min > max) throw new TollwayError("invalid-policy", "minAmount must not exceed maxAmount");
  if (config.previousQuoteSecrets?.some((secret) => typeof secret !== "string" || !secret)) {
    throw new TollwayError("invalid-policy", "previousQuoteSecrets must be non-empty strings");
  }
  const ttl = config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new TollwayError("invalid-policy", "quoteTtlSeconds must be a positive integer");
  }
}

/**
 * Runs the route's price function and checks its result against the bounds.
 * Anything wrong with the price is the service's misconfiguration, not the
 * agent's, so it is a 500 and nothing is charged. The reason names the
 * `invalid-amount` code but never echoes what the function threw, which may
 * carry internal detail.
 */
async function priceRequest(
  config: PaywallConfig,
  request: TollwayRequest,
  onPriceError: PaywallDeps["onPriceError"],
): Promise<{ ok: true; amount: string } | { ok: false; outcome: RejectedOutcome }> {
  const reject = (problem: string) =>
    ({
      ok: false,
      outcome: {
        kind: "rejected",
        status: 500,
        reason: `invalid-amount: dynamic price ${problem}`,
      },
    }) as const;
  if (typeof config.amount !== "function") return { ok: true, amount: config.amount };

  let priced: unknown;
  try {
    priced = await config.amount(request);
  } catch (error) {
    onPriceError?.(error, request);
    return reject("function failed");
  }
  if (typeof priced !== "string" || !INTEGER_AMOUNT.test(priced)) {
    return reject("must be a non-negative integer string");
  }
  const value = BigInt(priced);
  const min = parsePriceAmount(config.minAmount as string, "minAmount");
  const max = parsePriceAmount(config.maxAmount as string, "maxAmount");
  if (value < min || value > max) {
    return reject("is outside the configured bounds");
  }
  return { ok: true, amount: priced };
}

/**
 * The headers on a settled response: the x402 V2 `SettleResponse` in
 * PAYMENT-RESPONSE, and Tollway's signed receipt in TOLLWAY-RECEIPT. The
 * facilitator settled the payment, so `success` is always true here.
 */
function settlementHeaders(signed: SignedReceipt): Record<string, string> {
  const { settlement, network } = signed.receipt;
  const headers: Record<string, string> = { [TOLLWAY_RECEIPT_HEADER]: encodeHeader(signed) };
  if (settlement.kind === "transaction") {
    headers[PAYMENT_RESPONSE_HEADER] = encodePaymentResponseHeader({
      success: true,
      transaction: settlement.txHash,
      network: stellarCaip2(network),
    });
  }
  return headers;
}

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

/** Shared internally by gates created from one route table. */
export type InFlightSettlementResult = SettlementResult;

type SettlementContext = {
  signer: ReceiptSigner;
  receiptVersion: 1 | 2;
  cache?: SettlementCache;
  onCacheError?: (error: Error, key: string) => void;
  /** Settlements in progress in this process, by cache key. */
  inFlight: Map<string, Promise<SettlementResult>>;
  lockTtlMs: number;
  clock: () => number;
  servicePolicy?: { policy: ServicePolicy; store: ServicePolicyStore };
  onServicePolicyError?: (error: Error, payer: string) => void;
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

/**
 * The same payment is being settled right now. `Retry-After` is the signal a
 * client reads to resend the identical payment (issue #203): the offer
 * mismatch above is also a 409, but carries none, because that payment has
 * already settled and must not be retried. One second is the shortest wait
 * the header can express. Machine-readable codes for every rejection are #161.
 */
const SETTLEMENT_IN_PROGRESS: RejectedOutcome = {
  kind: "rejected",
  status: 409,
  reason: "settlement in progress",
  headers: { "retry-after": "1" },
};

/**
 * Turns a policy denial into a rejection. Both allowlist and denylist
 * denials use the same code and status, so the answer does not reveal which
 * list matched. Window limits carry `Retry-After` in whole seconds, rounded
 * up so a client that waits that long is inside the next window.
 */
function servicePolicyRejection(
  decision: Extract<ServicePolicyDecision, { allowed: false }>,
): RejectedOutcome {
  const retryAfter =
    decision.retryAfterMs === undefined
      ? undefined
      : String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  return {
    kind: "rejected",
    status: decision.code === SERVICE_POLICY_DENIALS.notAllowed ? 403 : 429,
    reason: decision.code,
    ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
  };
}

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
  replayOnly?: () => Promise<GateOutcome>,
): Promise<GateOutcome> {
  // A payment that already settled is answered from the cache before it is
  // verified again: on chain its authorization nonce is spent, so a second
  // verify fails and the retry would get a 402 instead of its receipt (#284).
  // The binding checks in toOutcome still apply to the cached receipt.
  const knownNonce = await handler.idempotencyKey?.({ payment });
  if (knownNonce !== undefined) {
    const knownKey = `${model}:${knownNonce}`;
    const pending = context.inFlight.get(knownKey);
    if (pending) {
      return toOutcome(await pending, offer, model, method, true);
    }
    const cached = await context.cache?.get(knownKey);
    if (cached) {
      const replay: SettlementResult = {
        ok: true,
        receipt: cached.receipt,
        method: cached.method,
        replayed: true,
      };
      return toOutcome(replay, offer, model, method, false);
    }
  }
  // The caller allows only a replay here (an expired quote): a payment that
  // has not settled is never verified or settled under it.
  if (replayOnly) {
    return replayOnly();
  }

  const verification = await handler.verify({ payment, offer });
  if (!verification.valid) {
    return { kind: "rejected", status: 402, reason: verification.reason };
  }
  // The cache lookup above used the derived nonce; a facilitator whose verify
  // disagrees with it would store under a key retries never look up.
  if (knownNonce !== undefined && verification.nonce !== knownNonce) {
    return {
      kind: "rejected",
      status: 500,
      reason: "facilitator verify returned a nonce that differs from its idempotency key",
    };
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

  // The in-flight slot is claimed before anything awaits, so a second copy
  // of this payment always finds it above and shares this attempt's result,
  // whether that is a receipt or a policy denial. Policy runs inside the
  // attempt and is consulted once per payment.
  const attempt = admitAndSettle(
    payment,
    offer,
    model,
    method,
    handler,
    verification,
    key,
    context,
  );
  context.inFlight.set(key, attempt);
  try {
    return await toOutcome(await attempt, offer, model, method, false);
  } finally {
    context.inFlight.delete(key);
  }
}

/**
 * Runs the service policy for a verified payer, then settles. The payer is
 * verified and no settlement lock has been taken, so a denial never reaches
 * /settle. Spend is recorded only for a fresh settlement: a replay was
 * already counted when it settled, and a failure frees the reservation.
 */
async function admitAndSettle<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  handler: Handler<TPayment>,
  verification: { payer: string; nonce: string },
  key: string,
  context: SettlementContext,
): Promise<SettlementResult> {
  const servicePolicy = context.servicePolicy;
  if (!servicePolicy) {
    return settleOnce(payment, offer, model, method, handler, verification, key, context);
  }

  const decision = await servicePolicy.store.admit({
    policy: servicePolicy.policy,
    payer: verification.payer,
    offer,
    model,
    now: context.clock(),
  });
  if (!decision.allowed) return { ok: false, outcome: servicePolicyRejection(decision) };
  const reservation = decision.reservation;
  if (!reservation) {
    return settleOnce(payment, offer, model, method, handler, verification, key, context);
  }

  let result: SettlementResult;
  try {
    result = await settleOnce(payment, offer, model, method, handler, verification, key, context);
  } catch (error) {
    // The settlement error is what the caller needs; a release failure on
    // top of it goes to the hook so it neither replaces nor hides it.
    await reportPolicyStoreFailure(
      () => servicePolicy.store.release(reservation),
      reservation,
      context,
    );
    throw error;
  }

  const settledNow = result.ok && !result.replayed;
  // The payment has settled (or definitely has not), so a store failure here
  // must not cost the payer the receipt. It goes to the hook instead.
  await reportPolicyStoreFailure(
    () =>
      settledNow
        ? servicePolicy.store.commit(reservation)
        : servicePolicy.store.release(reservation),
    reservation,
    context,
  );
  return result;
}

/** Runs a policy store write and routes a failure to onServicePolicyError. */
async function reportPolicyStoreFailure(
  write: () => Promise<void>,
  reservation: ServicePolicyReservation,
  context: SettlementContext,
): Promise<void> {
  try {
    await write();
  } catch (failure) {
    context.onServicePolicyError?.(
      asError(failure, "service policy store write failed"),
      reservation.payer,
    );
  }
}

/**
 * Turns a settlement result into the outcome for one request. A receipt is
 * only returned for the offer it was issued against, and for the HTTP method
 * it was paid with; anything else is a rejection, never a replay. See
 * docs/design.md, "Design notes" (duplicate protection).
 *
 * A v1 receipt is bound by its six offer fields. A v2 receipt is also bound
 * by its `offerHash` and `method`, so a cached v2 receipt for offer A is
 * never served for offer B even when the six fields match (#166).
 */
async function toOutcome(
  result: SettlementResult,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  waited: boolean,
): Promise<GateOutcome> {
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
  const body = result.receipt.receipt;
  // A receipt this call just settled was built from this very offer and
  // method, so hashing the offer again would only repeat that work. Any
  // receipt from elsewhere, a concurrent request or the cache, is checked.
  if (body.version === 2 && (waited || result.replayed)) {
    if (body.method !== method || body.offerHash !== (await hashOffer(offer))) {
      return OFFER_MISMATCH;
    }
  }
  const outcome: GateOutcome = {
    kind: "settled",
    status: 200,
    headers: settlementHeaders(result.receipt),
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

  // Issue #166: a v2 receipt carries the SHA-256 of the canonical offer the
  // payer accepted, so two offers for the same URL and price with different
  // models or facilitator URLs produce distinguishable receipts, and the
  // HTTP method, so a receipt for GET does not unlock POST. v1 stays the
  // default until the operator switches (see `PaywallDeps.receiptVersion`).
  const v2 =
    context.receiptVersion === 2 ? { offerHash: await hashOffer(offer), method } : undefined;
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
      ...v2,
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

const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding"]);

/**
 * The 402 for a request with no payment. It carries the x402 V2
 * `PaymentRequired` in the PAYMENT-REQUIRED header and as the JSON body.
 * When the route accepts mpp-charge, the MPP challenge `mppx` built (its
 * `WWW-Authenticate: Payment ...` header) is added alongside, so an agent can
 * answer with either protocol.
 */
async function paymentRequired(
  offer: PaymentOffer,
  request: TollwayRequest,
  acceptedModels: SettlementModel[],
  mppChargeHandler: MppChargeHandler | undefined,
  config: PaywallConfig,
  quote: string | undefined,
): Promise<GateOutcome> {
  const challenge: PaymentRequired = {
    x402Version,
    resource: { url: offer.resource },
    accepts: [
      toPaymentRequirements(offer, {
        maxTimeoutSeconds: config.maxTimeoutSeconds,
        extra: config.extra,
      }),
    ],
  };
  // Issue #154: attach the Bazaar discovery extension when the route
  // opts in. The upstream helper builds the shape; a cataloguing
  // facilitator reads it back with `extractDiscoveryInfo` at settle
  // time. Routes without a `discovery` config publish nothing.
  if (config.discovery) {
    challenge.extensions = {
      ...(challenge.extensions ?? {}),
      ...declareDiscoveryExtension(toDeclareDiscoveryInput(config.discovery)),
    };
  }
  const headers: Record<string, string> = {
    [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(challenge),
  };
  if (quote !== undefined) headers[TOLLWAY_QUOTE_HEADER] = quote;
  if (acceptedModels.includes("mpp-charge") && mppChargeHandler?.challenge) {
    const mpp = await mppChargeHandler.challenge({
      offer,
      request: { method: request.method, url: request.url },
    });
    for (const [name, value] of Object.entries(mpp.headers)) {
      // The adapters send the offer as the JSON body, so headers that
      // describe mppx's own body would mislabel it.
      if (!BODY_HEADERS.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
  }
  return { kind: "payment-required", status: 402, headers, challenge };
}

/**
 * Builds the gate from a paywall config. It settles x402 per-request and
 * mpp-charge; a routing decision for another model is rejected rather than
 * mishandled. See docs/design.md, "Build plan", Phase 1.
 */
export function createPaywall(config: PaywallConfig, deps: PaywallDeps): Gate {
  return createPaywallWithInFlight(config, deps, new Map());
}

/** Internal constructor used by route tables to share duplicate coordination. */
export function createPaywallWithInFlight(
  config: PaywallConfig,
  deps: PaywallDeps,
  inFlight: Map<string, Promise<InFlightSettlementResult>>,
): Gate {
  validateDynamicPriceConfig(config);
  assertCompleteLocking(deps.cache);
  if (deps.servicePolicy) validateServicePolicy(deps.servicePolicy);
  // Issue #154: refuse an invalid discovery declaration at construction
  // time rather than at every 402. The upstream validator checks the
  // declaration's schema and (optionally) the route template.
  if (config.discovery) validateDiscoveryAtConstruction(config.discovery);
  const acceptedModels = config.models ?? ["x402"];
  const clock = deps.clock ?? Date.now;
  const servicePolicyStore =
    deps.servicePolicy && (deps.servicePolicyStore ?? createInMemoryServicePolicyStore());
  if (deps.receiptVersion !== undefined && deps.receiptVersion !== 1 && deps.receiptVersion !== 2) {
    throw new TypeError(`receiptVersion must be 1 or 2, got ${String(deps.receiptVersion)}`);
  }
  const context: SettlementContext = {
    signer: deps.signer,
    receiptVersion: deps.receiptVersion ?? 1,
    cache: deps.cache,
    onCacheError: deps.onCacheError,
    ...(deps.onServicePolicyError ? { onServicePolicyError: deps.onServicePolicyError } : {}),
    inFlight,
    lockTtlMs: deps.settlementLockTtlMs ?? DEFAULT_SETTLEMENT_LOCK_TTL_MS,
    clock,
    ...(deps.servicePolicy && servicePolicyStore
      ? { servicePolicy: { policy: deps.servicePolicy, store: servicePolicyStore } }
      : {}),
  };

  return async function gate(request): Promise<GateOutcome> {
    const method = request.method.toUpperCase();
    const signatureHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    const mppCredential = acceptedModels.includes("mpp-charge")
      ? readMppCredential(request.headers)
      : undefined;

    // The x402 payment is decoded before pricing, because a dynamic-price
    // quote comes back inside it, in `accepted.extra.tollwayQuote`.
    let x402Payment: X402Payload | undefined;
    if (signatureHeader && !mppCredential) {
      try {
        x402Payment = decodePaymentSignatureHeader(signatureHeader);
      } catch (error) {
        return {
          kind: "rejected",
          status: 400,
          reason: `PAYMENT-SIGNATURE is not a base64 x402 PaymentPayload: ${asError(error, "invalid header").message}`,
        };
      }
      if (x402Payment.x402Version !== x402Version) {
        return {
          kind: "rejected",
          status: 400,
          reason: `unsupported x402Version ${String(x402Payment.x402Version)}; this gate speaks x402 version ${x402Version}`,
        };
      }
    }

    const resource = config.resource ?? request.url;
    let amount: string;
    let quote: string | undefined;
    let candidateQuote: string | undefined;
    let quoteExpired = false;
    if (typeof config.amount !== "function") {
      amount = config.amount;
    } else {
      const now = clock();
      candidateQuote = x402Payment
        ? quoteFromPayload(x402Payment)
        : readHeader(request.headers, TOLLWAY_QUOTE_HEADER);
      const verified = candidateQuote
        ? await readQuote(candidateQuote, resource, now, quoteSecrets(config))
        : undefined;
      // An expired quote is still honoured for an x402 payment, but only to
      // replay a receipt that payment already settled under it; a client that
      // retries after expiry must get its receipt, not a 402 it would pay
      // again. MPP credentials carry no idempotency key, so they get a 402.
      if (verified && (!verified.expired || x402Payment)) {
        amount = verified.payload.amount;
        quote = candidateQuote;
        quoteExpired = verified.expired;
      } else {
        const priced = await priceRequest(config, request, deps.onPriceError);
        if (!priced.ok) return priced.outcome;
        amount = priced.amount;
        quote = await createQuote(
          resource,
          amount,
          now,
          config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS,
          config.quoteSecret ?? "",
        );
      }
    }
    const offer: PaymentOffer = {
      resource,
      amount,
      asset: config.asset,
      payTo: config.payTo,
      network: config.network,
      models: acceptedModels,
      facilitatorUrl: config.facilitatorUrl,
      quote,
    };

    // A dynamic price is only paid against a quote this gate issued: a
    // missing, expired, tampered or mismatched one gets a fresh 402.
    if (typeof config.amount === "function" && candidateQuote !== quote) {
      return paymentRequired(offer, request, acceptedModels, deps.mppChargeHandler, config, quote);
    }

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

    if (!x402Payment) {
      return paymentRequired(offer, request, acceptedModels, deps.mppChargeHandler, config, quote);
    }

    const decision = deps.router
      ? await deps.router.decide({ counterparty: offer.payTo, resource: offer.resource, offer })
      : ({ model: acceptedModels[0], reason: "default" } as const);

    if (decision.model === "x402") {
      const payment: X402Payment = { model: "x402", payload: x402Payment };
      // Under an expired quote the payment may only replay; if it never
      // settled, the agent gets a fresh price and quote instead.
      const freshChallenge = async (): Promise<GateOutcome> => {
        const priced = await priceRequest(config, request, deps.onPriceError);
        if (!priced.ok) return priced.outcome;
        const fresh = await createQuote(
          resource,
          priced.amount,
          clock(),
          config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS,
          config.quoteSecret ?? "",
        );
        return paymentRequired(
          { ...offer, amount: priced.amount, quote: fresh },
          request,
          acceptedModels,
          deps.mppChargeHandler,
          config,
          fresh,
        );
      };
      return settleWithHandler(
        payment,
        offer,
        "x402",
        method,
        deps.facilitator,
        context,
        quoteExpired ? freshChallenge : undefined,
      );
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

/**
 * Issue #154: maps the Tollway-shape discovery declaration onto the
 * upstream {@link DeclareDiscoveryExtensionInput}. The upstream helper
 * expects a `bodyType` to discriminate body routes; the query variant
 * omits it.
 */
function toDeclareDiscoveryInput(
  declaration: DiscoveryDeclaration,
): DeclareDiscoveryExtensionInput {
  if (declaration.kind === "query") {
    const input: DeclareDiscoveryExtensionInput = {};
    if (declaration.input) input.input = declaration.input;
    if (declaration.inputSchema) input.inputSchema = declaration.inputSchema;
    if (declaration.pathParams) input.pathParams = declaration.pathParams;
    if (declaration.pathParamsSchema) input.pathParamsSchema = declaration.pathParamsSchema;
    if (declaration.output) input.output = declaration.output;
    return input;
  }
  const input: DeclareDiscoveryExtensionInput = { bodyType: declaration.bodyType };
  if (declaration.input) input.input = declaration.input;
  if (declaration.inputSchema) input.inputSchema = declaration.inputSchema;
  if (declaration.pathParams) input.pathParams = declaration.pathParams;
  if (declaration.pathParamsSchema) input.pathParamsSchema = declaration.pathParamsSchema;
  if (declaration.output) input.output = declaration.output;
  return input;
}

/**
 * Issue #154: validates the discovery declaration at `createPaywall`
 * time with the upstream schema check. A declaration that fails here
 * will never reach a 402, so the error surfaces where it originates.
 */
function validateDiscoveryAtConstruction(declaration: DiscoveryDeclaration): void {
  // Use the spec-level validator: it checks protocol-level invariants
  // (`info.input.type`, allowed methods, `bodyType`) that are required
  // for every declaration before enrichment. The info-vs-schema
  // `validateDiscoveryExtension` is more precise but assumes the
  // declaration has already been enriched with request-time fields
  // (`method`, concrete `input` matching the schema), which only
  // happens when the facilitator pulls the extension out of a real
  // payment payload.
  const built = declareDiscoveryExtension(toDeclareDiscoveryInput(declaration));
  for (const extension of Object.values(built)) {
    const result = validateDiscoveryExtensionSpec(extension as unknown as Record<string, unknown>);
    if (!result.valid) {
      throw new TollwayError(
        "invalid-quote",
        `invalid Bazaar discovery declaration: ${result.errors?.join("; ") ?? "unknown error"}`,
      );
    }
  }
}
