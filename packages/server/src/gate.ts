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
  type SettlementRef,
  type SignedReceipt,
  type StellarNetwork,
  signReceipt,
  TollwayError,
  utf8Bytes,
  type X402Payment,
} from "@vegaforge/tollway-core";
import { x402Version } from "@x402/core";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload as X402Payload,
} from "@x402/core/types";
import type {
  LockingSettlementCache,
  SettlementCache,
  SettlementEntry,
  SettlementLock,
} from "./cache.js";
import {
  checkDiscoveryDeclaration,
  type DiscoveryDeclaration,
  discoveryExtensions,
  discoveryResourceInfo,
} from "./discovery.js";
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  type FacilitatorClient,
  stellarCaip2,
  toPaymentRequirements,
} from "./facilitator.js";
import {
  type GateRejection,
  gateRejection,
  isFacilitatorUnavailable,
  isOutcomeUnknown,
  retryAfterSeconds,
} from "./gate-errors.js";
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
  TOLLWAY_CHANNEL_HEADER,
  TOLLWAY_QUOTE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./headers.js";
import {
  type MppChannelHandler,
  type MppChannelRefusal,
  parseMppChannelCredential,
} from "./mpp-channel.js";
import type { MppChargeHandler } from "./mpp-charge.js";
import {
  createOfferReceiptIssuer,
  OFFER_RECEIPT_EXTENSION_KEY,
  type OfferReceiptIssuer,
  type OfferReceiptOptions,
} from "./offer-receipt.js";
import {
  paymentIdentifierExtensions,
  paymentIdentifierKey,
  readPaymentIdentifier,
} from "./payment-identifier.js";

import {
  matchAcceptedOption,
  type ResolvedPaymentOption,
  resolvePaymentOptions,
} from "./payment-options.js";
import type { PaymentReceiptArchive } from "./payment-receipt-archive.js";
import {
  createInMemoryServicePolicyStore,
  SERVICE_POLICY_DENIALS,
  type ServicePolicy,
  type ServicePolicyDecision,
  type ServicePolicyReservation,
  type ServicePolicyStore,
  validateServicePolicy,
} from "./service-policy.js";
import {
  checkStellarExactPayment,
  DEFAULT_MAX_PAYMENT_SIGNATURE_LENGTH,
  type LatestLedgerSource,
  type PrevalidationReason,
} from "./stellar-static-validation.js";
import { isPreSendFailure } from "./transport-errors.js";

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

/**
 * One way to pay for a route (#158): an amount of one asset, paid to one
 * account on one network, settled through one facilitator.
 */
export type PaymentOption = {
  /** Price as an integer string in the asset's smallest unit. */
  amount: string;
  /** The Soroban asset contract (`C...`) x402 names. */
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  /**
   * The facilitator that verifies and settles this option. Defaults to
   * `PaywallDeps.facilitator`; options on different networks usually need
   * different ones. An x402 option with neither is refused at `createPaywall`.
   */
  facilitator?: FacilitatorClient;
  /** Recorded on the offer, as the single-option field of the same name. */
  facilitatorUrl?: string;
  /** x402: how long the payment stays valid, in seconds. Defaults to 60. */
  maxTimeoutSeconds?: number;
  /** x402: scheme-specific data, sent as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
};

/** The settings every paywall has, whether it offers one payment option or several. */
type PaywallCommon = {
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
  /** Accepted models, in order of preference. Defaults to x402 only. */
  models?: SettlementModel[];
  /** Overrides the request URL as the resource identifier in the receipt. */
  resource?: string;
  /**
   * Publishes the route through x402 Bazaar discovery (#154): the 402 then
   * carries `extensions.bazaar`, enriched with the request method and
   * `routeTemplate`, plus `description` and `mimeType` on its `resource`.
   * Without it the route publishes nothing. An invalid declaration fails
   * at `createPaywall`. See `DiscoveryDeclaration` and docs/discovery.
   */
  discovery?: DiscoveryDeclaration;
  /**
   * Issues the x402 offer-receipt extension (#172), signed with
   * `PaywallDeps.signer`: a signed offer per x402 requirement in the 402's
   * `extensions["offer-receipt"]`, and a signed receipt in the settled x402
   * payment's PAYMENT-RESPONSE. Off by default, and responses are then
   * unchanged. An unusable signer or validity fails at `createPaywall`.
   * See `OfferReceiptOptions` and docs/receipt-format.md.
   */
  offerReceipt?: boolean | OfferReceiptOptions;
  /**
   * The x402 `payment-identifier` extension (#153). Every 402 declares it.
   * When a payment carries an id, the gate also keys the settlement on that
   * id scoped to the verified payer, so a client that re-signs the same
   * payment as a new envelope gets its first receipt back instead of paying
   * twice. With `required: true` a payment without an id is rejected with
   * 400. Defaults to `{ required: false }`.
   */
  paymentIdentifier?: { required?: boolean };
  /**
   * Two-phase settlement (#152), used when an adapter runs with
   * `settlement: "after-handler"` (or a caller uses `gate.authorize`): the
   * payment is verified and locked, the route handler runs with its response
   * held, and the payment settles only if the handler succeeded.
   */
  twoPhase?: TwoPhaseConfig;
};

/** How two-phase settlement judges and holds a handler's response. */
export type TwoPhaseConfig = {
  /**
   * True when a response status means the handler failed, so the payment is
   * abandoned instead of settled. Defaults to any 5xx.
   */
  isFailureStatus?: (status: number) => boolean;
  /**
   * Largest response body held while the payment settles, in bytes. A
   * larger (or streamed past this) response abandons the payment and the
   * client gets a 500 `response-too-large` instead. Defaults to 1 MiB.
   */
  maxResponseBytes?: number;
};

/** A paywall with one payment option, set with the top-level fields. */
export type SinglePaymentOptionConfig = {
  /**
   * Price as an integer string in the asset's smallest unit, or a function
   * that prices each request (dynamic pricing, #157).
   */
  amount: string | DynamicPriceFunction;
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  facilitatorUrl?: string;
  /** x402: how long the payment stays valid, in seconds. Defaults to 60. */
  maxTimeoutSeconds?: number;
  /** x402: scheme-specific data, sent as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
  accepts?: never;
};

/**
 * A paywall with several payment options (#158), in the service's order of
 * preference. The 402 lists all of them; a payment settles with the one the
 * payer's `accepted` matches exactly, and is refused if it matches none.
 * Dynamic pricing applies to single-option paywalls only.
 */
export type PaymentOptionsConfig = {
  accepts: readonly PaymentOption[];
  amount?: never;
  asset?: never;
  payTo?: never;
  network?: never;
  facilitatorUrl?: never;
  maxTimeoutSeconds?: never;
  extra?: never;
};

/**
 * What the service charges for a resource: one payment option in the
 * top-level fields, or several in `accepts`. A single option is the same as
 * a one-item `accepts` list, and its 402 is unchanged by #158.
 */
export type PaywallConfig = PaywallCommon & (SinglePaymentOptionConfig | PaymentOptionsConfig);

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
  /**
   * A refusal with a machine-readable `code` (#161). Adapters render it with
   * `renderGateRejection`, so every framework sends the same body.
   */
  | GateRejection;

/**
 * Local checks an x402 payment passes before the gate spends a `/verify` on
 * it (#159). They run for every facilitator client except the offline mock,
 * whose payments are not Stellar transactions.
 */
export type PaymentPrevalidationOptions = {
  /**
   * Longest `PAYMENT-SIGNATURE` header accepted, in characters, checked
   * before anything is decoded. Defaults to 16 384. Applies to every client,
   * the mock included.
   */
  maxPaymentSignatureLength?: number;
  /**
   * Source of the latest closed ledger. With one, an authorization whose
   * `signatureExpirationLedger` is already behind it is refused locally;
   * when the ledger is unavailable the check is skipped, never failed. See
   * `createLatestLedgerSource`.
   */
  latestLedger?: LatestLedgerSource;
  /**
   * Called for every payment refused before `/verify`, so operators can see
   * flood volume. `rejectedTotal` counts this gate's local refusals so far.
   */
  onRejected?: (event: PrevalidationRejection) => void;
};

/** One payment refused locally, as `PaymentPrevalidationOptions.onRejected` sees it. */
export type PrevalidationRejection = {
  reason: PrevalidationReason;
  resource: string;
  rejectedTotal: number;
};

/** A payment gate for one paid resource, built by {@link createPaywall}. */
export type Gate = (request: TollwayRequest) => Promise<GateOutcome>;

/** Why a two-phase payment was let go without settling. */
export type AbandonReason =
  | "handler-threw"
  | "handler-failed"
  | "response-too-large"
  | "client-closed";

/** What `settle()` resolves to: the receipt, or why the payment did not settle. */
export type SettleOutcome = Extract<GateOutcome, { kind: "settled" | "rejected" }>;

/**
 * A verified payment, locked against duplicates, that has not settled. The
 * caller runs the route handler with its response held, then calls exactly
 * one of `settle()` or `abandon()`. See docs/two-phase-settlement.md.
 */
export type AuthorizedPayment = {
  kind: "authorized";
  /** Largest response body the caller may hold before abandoning, in bytes. */
  maxResponseBytes: number;
  /** True when the handler's status means it failed; then call `abandon`. */
  isFailure(status: number): boolean;
  /**
   * Settles the payment. Resolves to the settled outcome, whose headers go on
   * the held response, or to a rejection: the facilitator refused, the
   * handler outlived the payment's validity window, or the settlement lock
   * was lost. On a rejection discard the held response and send the
   * rejection instead. Throws a TypeError when called a second time or after
   * `abandon()`.
   */
  settle(): Promise<SettleOutcome>;
  /**
   * Lets the payment go without settling and releases its lock. Idempotent,
   * and a no-op after `settle()`: a settlement cannot be undone.
   */
  abandon(reason: AbandonReason): Promise<void>;
};

/**
 * What `gate.authorize` decided. A replay of a payment that already settled
 * comes back as `settled`, as from the single-shot gate: the handler runs,
 * and nothing settles a second time.
 */
export type AuthorizeOutcome = GateOutcome | AuthorizedPayment;

/** A gate that can also settle after the route handler (#152). */
export type PaywallGate = Gate & {
  authorize(request: TollwayRequest): Promise<AuthorizeOutcome>;
};

/**
 * The one payment measurement the gate reports to an observer. Structurally
 * compatible with `PaymentMetric` from @vegaforge/tollway-observability,
 * without the server package taking a dependency on it.
 */
export type PaymentObserverMetric = {
  payer: string;
  payee: string;
  model: SettlementModel;
  amount: string;
  asset: string;
  latencyMs: number;
  outcome: "settled" | "failed" | "skipped";
  at: string;
};

/** The `receipt.created` event the gate emits to an observer. */
export type PaymentObserverEvent = {
  id?: string;
  type: "receipt.created";
  at: string;
  data: Record<string, unknown>;
};

/**
 * Minimal sink for settled and failed payments. An `ObservabilityHub`
 * satisfies it; delivery failures must not change the gate's outcome.
 */
export type PaymentObserver = {
  record(metric: PaymentObserverMetric): void;
  emit(event: PaymentObserverEvent): Promise<unknown>;
};

/**
 * The services a gate uses: the receipt signer, the facilitator, and the
 * optional MPP charge handler, router and settlement cache.
 */
export type PaywallDeps = {
  signer: ReceiptSigner;
  /**
   * The facilitator for every payment option that does not name its own.
   * Required unless each x402 option sets `facilitator`, or the paywall only
   * accepts mpp-charge.
   */
  facilitator?: FacilitatorClient;
  mppChargeHandler?: MppChargeHandler;
  mppChannelHandler?: MppChannelHandler;
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
   * Called when the settlement cache, or the receipt archive, fails after a
   * payment has settled. The same error is also set as `cacheError` on the
   * outcome.
   */
  onCacheError?: (error: Error, key: string) => void;
  /**
   * Durable record of settled payments (#162). A retry whose entry has left
   * the settlement cache is answered from here with its original receipt,
   * before `/verify`, so a payer who already paid is never refused or charged
   * again. Every fresh settlement is written to it. See
   * `PaymentReceiptArchive` and docs/receipt-archive.md.
   */
  receiptArchive?: PaymentReceiptArchive;
  /**
   * Called when a receipt archive read fails. The request then goes on to
   * `/verify` as if the archive had no entry, the behaviour before #162: the
   * facilitator refuses a spent payment, so nothing is charged twice, but the
   * payer may get a 402 instead of the replay. Write failures go to
   * `onCacheError`.
   */
  onArchiveError?: (error: Error, key: string) => void;
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
  /**
   * How long the gate waits for each facilitator call, in milliseconds.
   * Defaults to 15 000. A `/verify` that misses it is rejected with 503 and
   * nothing is settled. A `/settle` that misses it is answered with 503
   * `settlement-unknown`, and the payment is held (see
   * `ambiguousSettlementHoldMs`) because it may still land.
   * See docs/failure-modes.md.
   */
  facilitatorTimeoutMs?: number;
  /**
   * How long a payment whose `/settle` outcome is unknown stays held, in
   * milliseconds, counted from the start of the `/settle` call. Defaults to
   * 120 000.
   *
   * A `/settle` is ambiguous when it misses `facilitatorTimeoutMs`, or fails
   * after the request may have reached the facilitator (a timeout, a reset,
   * an error answer). While a payment is held, this process keeps its
   * in-flight slot and keeps renewing the cross-process settlement lock, so
   * no retry in any process calls `/settle` for it again. The hold ends early
   * when the abandoned call answers: a late success is recorded in the cache
   * so a retry replays it, and a definite failure frees the payment.
   *
   * Set it to at least the payment authorization's lifetime
   * (`maxTimeoutSeconds`, 60 s by default) plus the facilitator transport
   * timeout, so the hold outlasts any moment at which the payment could
   * still land. If this process dies while holding, the lock expires after
   * `settlementLockTtlMs`.
   */
  ambiguousSettlementHoldMs?: number;
  /**
   * Local checks before `/verify` for x402 payments (#159). They are on by
   * default for every facilitator client except `createMockFacilitator`;
   * this only tunes them. See `PaymentPrevalidationOptions`.
   */
  paymentPrevalidation?: PaymentPrevalidationOptions;
  /**
   * `Retry-After`, in whole seconds, for rejections a client should answer
   * by sending the same payment again (#161). `settlementInProgress` defaults
   * to 1: the other request holding the payment usually finishes within a
   * second, and the 409 contract from #203 promised that value.
   * `facilitatorUnavailable` defaults to 1 as well. The 503
   * `settlement-unknown` always uses the hold (`ambiguousSettlementHoldMs`),
   * because a retry before then cannot be answered.
   */
  retryAfterSeconds?: { settlementInProgress?: number; facilitatorUnavailable?: number };
  /** Clock for quote expiry and service policy windows; injected tests can avoid waiting. */
  clock?: () => number;
  /**
   * Optional observability sink (#106). Called for a fresh settlement and for
   * a rejected verification or settlement; a replayed cache hit is not
   * reported again. The gate never awaits the event's delivery.
   */
  observer?: PaymentObserver;
  /**
   * Called when the observer throws or its event delivery rejects. The
   * payment outcome is unchanged.
   */
  onObserverError?: (error: unknown) => void;
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

/**
 * What a handler's settle returns. x402 and mpp-charge settle a transaction;
 * mpp-channel anchors the receipt at a channel commitment instead. A
 * rejection may name its status (a stale voucher is the payer's problem, a
 * 402); without one it is a 502, the upstream refusing.
 */
type HandlerSettlement =
  | { settled: true; txHash: string }
  | { settled: true; settlement: SettlementRef; txHash?: string }
  | { settled: false; reason: string }
  | ({ settled: false } & MppChannelRefusal);

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
  }): Promise<HandlerSettlement>;
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
  const price = config.amount;
  const reject = (problem: string) =>
    ({
      ok: false,
      outcome: gateRejection("price-unavailable", `dynamic price ${problem}`),
    }) as const;
  if (typeof price !== "function") {
    // Only a dynamic single-option paywall is priced per request.
    throw new TypeError("priceRequest needs a dynamic price function");
  }

  let priced: unknown;
  try {
    priced = await price(request);
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
function settlementHeaders(
  signed: SignedReceipt,
  extensions?: Record<string, unknown>,
): Record<string, string> {
  const { settlement, network } = signed.receipt;
  const headers: Record<string, string> = { [TOLLWAY_RECEIPT_HEADER]: encodeHeader(signed) };
  if (settlement.kind === "transaction") {
    headers[PAYMENT_RESPONSE_HEADER] = encodePaymentResponseHeader({
      success: true,
      transaction: settlement.txHash,
      network: stellarCaip2(network),
      ...(extensions ? { extensions } : {}),
    });
  }
  return headers;
}

/**
 * The settled headers with the offer-receipt extension added (#172). The
 * extension answers an x402 offer, so only an x402 settlement on a route
 * that opted in gets one; every other settlement takes the synchronous path,
 * so the extension costs nothing where it is off.
 */
async function settlementHeadersFor(
  signed: SignedReceipt,
  context: Pick<SettlementContext, "offerReceipt">,
): Promise<Record<string, string>> {
  if (!context.offerReceipt || signed.receipt.model !== "x402") {
    return settlementHeaders(signed);
  }
  return settlementHeaders(signed, {
    [OFFER_RECEIPT_EXTENSION_KEY]: await context.offerReceipt.receipt(signed),
  });
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
  | {
      ok: false;
      outcome: RejectedOutcome;
      /**
       * Set when the `/settle` outcome is unknown: the payment may still
       * land, so the caller holds its slot and lock until the hold ends.
       */
      hold?: SettlementHold;
    };

/** Shared internally by gates created from one route table. */
export type InFlightSettlementResult = SettlementResult;

type SettlementContext = {
  signer: ReceiptSigner;
  receiptVersion: 1 | 2;
  /** Present only for a route that opted in to the offer-receipt extension. */
  offerReceipt?: OfferReceiptIssuer;
  cache?: SettlementCache;
  onCacheError?: (error: Error, key: string) => void;
  archive?: PaymentReceiptArchive;
  onArchiveError?: (error: Error, key: string) => void;
  /** Settlements in progress in this process, by cache key. */
  inFlight: Map<string, Promise<SettlementResult>>;
  lockTtlMs: number;
  clock: () => number;
  servicePolicy?: { policy: ServicePolicy; store: ServicePolicyStore };
  onServicePolicyError?: (error: Error, payer: string) => void;
  facilitatorTimeoutMs: number;
  ambiguousHoldMs: number;
  /** The 409 for a payment another request is settling, with its configured `Retry-After`. */
  settlementInProgress: RejectedOutcome;
  /** `Retry-After` seconds for a 503 `facilitator-unavailable`. */
  facilitatorRetryAfter: string;
};

/**
 * How long a cross-process settlement lock lives if its holder never
 * releases it. Matches the default cache TTL.
 */
const DEFAULT_SETTLEMENT_LOCK_TTL_MS = 30_000;

/** Largest response a two-phase caller holds when the config sets none. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/** Deadline for one facilitator call when the caller sets none. */
const DEFAULT_FACILITATOR_TIMEOUT_MS = 15_000;

/**
 * How long a payment whose `/settle` outcome is unknown stays held when the
 * caller sets nothing: twice the default 60 s authorization lifetime, which
 * also covers the 90 s default transport timeout of `@x402/core`.
 */
const DEFAULT_AMBIGUOUS_HOLD_MS = 120_000;

/**
 * Runs the paid work before the payment settles and says whether it
 * succeeded. Only the call that is about to settle a payment runs it; a
 * replay or a call that shares another call's settlement does not.
 */
type BeforeSettle = () => Promise<boolean>;

/** The paid work failed, so the verified payment was not settled (#206). */
const WORK_FAILED: RejectedOutcome = gateRejection(
  "work-failed",
  "not settled: the paid work did not succeed",
);

const OFFER_MISMATCH: RejectedOutcome = gateRejection(
  "offer-mismatch",
  "payment already settled for a different offer",
);

/**
 * The same payment is being settled right now. `Retry-After` is the signal a
 * client reads to resend the identical payment (issue #203): the offer
 * mismatch above is also a 409, but carries none, because that payment has
 * already settled and must not be retried. The wait is configurable through
 * `PaywallDeps.retryAfterSeconds` and defaults to one second, the shortest
 * the header can express.
 */
function settlementInProgress(seconds: number): RejectedOutcome {
  return gateRejection("settlement-in-progress", "settlement in progress", {
    headers: { "retry-after": String(seconds) },
  });
}

/** The 503 for a facilitator that could not be reached; nothing was settled. */
function facilitatorUnavailable(message: string, retryAfter: string): RejectedOutcome {
  return gateRejection("facilitator-unavailable", message, {
    headers: { "retry-after": retryAfter },
  });
}

/** A facilitator call that outlived the gate's deadline. */
class FacilitatorDeadlineError extends Error {
  constructor(
    readonly operation: "verify" | "settle",
    readonly timeoutMs: number,
  ) {
    super(`facilitator ${operation} did not answer within ${timeoutMs}ms`);
    this.name = "FacilitatorDeadlineError";
  }
}

/** How an abandoned call eventually answered. */
type LateAnswer<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Waits for `work` at most `timeoutMs`, then rejects with a
 * FacilitatorDeadlineError. The timer does not keep the process alive. When
 * the deadline wins, the abandoned call's eventual answer, success or
 * failure, goes to `onLate`, so a deadline never leaves an unhandled
 * rejection behind and the caller always learns how the call ended.
 */
function withDeadline<T>(
  work: Promise<T>,
  operation: "verify" | "settle",
  timeoutMs: number,
  onLate?: (answer: LateAnswer<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      work.then(
        (value) => onLate?.({ ok: true, value }),
        (error: unknown) => onLate?.({ ok: false, error }),
      );
      reject(new FacilitatorDeadlineError(operation, timeoutMs));
    }, timeoutMs);
    unrefTimer(timer);
    work.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Lets a timer run without keeping the process alive for it. */
function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

/**
 * A payment whose `/settle` outcome is unknown. `done` resolves when the hold
 * ends: when the abandoned call gives a definite answer, or when `holdMs`
 * has passed since the call started, whichever comes first. It never
 * rejects.
 */
type SettlementHold = { done: Promise<void>; holdMs: number; end(): void };

function startHold(holdMs: number): SettlementHold {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const timer = setTimeout(() => finish(), holdMs);
  unrefTimer(timer);
  return {
    done,
    holdMs,
    end() {
      clearTimeout(timer);
      finish();
    },
  };
}

/**
 * Thrown inside the gate when `/settle` failed in a way that may still have
 * reached the facilitator. It carries the hold so every layer between the
 * call and the request can keep the payment held, and it is unwrapped to
 * `original` before anything leaves the gate.
 */
class AmbiguousSettlementFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly hold: SettlementHold,
  ) {
    super("settlement outcome unknown");
    this.name = "AmbiguousSettlementFailure";
  }
}

/** Rethrows the error a caller should see, never the internal wrapper. */
function unwrapFailure(error: unknown): unknown {
  return error instanceof AmbiguousSettlementFailure ? error.original : error;
}

/** Waits on another request's settlement, surfacing its real error. */
async function awaitPending(pending: Promise<SettlementResult>): Promise<SettlementResult> {
  try {
    return await pending;
  } catch (error) {
    throw unwrapFailure(error);
  }
}

/**
 * The 503 for a `/settle` that outlived its deadline. The payment may have
 * settled, so the answer tells the agent to retry rather than pay again, and
 * carries the hold as `Retry-After`: after it, a retry either replays the
 * receipt or settles a payment that is known not to have landed.
 */
function settlementUnknownOutcome(problem: string, holdMs: number): RejectedOutcome {
  return gateRejection(
    "settlement-unknown",
    `settlement-unknown: ${problem}, so the payment may have settled`,
    { headers: { "retry-after": retryAfterSeconds(holdMs) } },
  );
}

/** Calls an operator hook without letting the hook's own failure escape. */
function report(
  hook: ((error: Error, key: string) => void) | undefined,
  error: Error,
  key: string,
): void {
  try {
    hook?.(error, key);
  } catch (hookFailure) {
    // Here the answer has already gone to the agent, so nothing can throw
    // to: a hook failure would become an unhandled rejection. Log both.
    console.error(`tollway: onCacheError threw while reporting for ${key}`, hookFailure, error);
  }
}

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
    decision.retryAfterMs === undefined ? undefined : retryAfterSeconds(decision.retryAfterMs);
  const rejection = gateRejection(decision.code, decision.code);
  // The status follows the table: 403 for the lists, 429 for the windows.
  rejection.status = decision.code === SERVICE_POLICY_DENIALS.notAllowed ? 403 : 429;
  if (retryAfter !== undefined) rejection.headers = { "retry-after": retryAfter };
  return rejection;
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

/**
 * Told the outcome of a payment attempt this request owns (#106): its
 * verification, or the settlement it started. `undefined` means the attempt
 * threw. Requests that only share another request's in-flight settlement,
 * or answer from the cache, never call it, so one payment is reported once.
 */
type AttemptReporter = (outcome: GateOutcome | undefined) => void;

function reported(report: AttemptReporter | undefined, outcome: GateOutcome): GateOutcome {
  report?.(outcome);
  return outcome;
}

/**
 * Looks a payment up in the receipt archive. A failed read is reported and
 * treated as no entry: the payment then goes to `/verify`, which refuses a
 * spent authorization, so the failure can cost the payer a replay but never
 * a second charge.
 */
async function readArchive(
  key: string,
  context: SettlementContext,
): Promise<SettlementEntry | undefined> {
  if (!context.archive) return undefined;
  try {
    return await context.archive.findByPaymentKey(key);
  } catch (error) {
    context.onArchiveError?.(asError(error, "receipt archive read failed"), key);
    return undefined;
  }
}

/**
 * Records a fresh settlement in the cache and the archive. Both writes are
 * awaited; a failure must not cost the payer the receipt, so the first one
 * is returned for `cacheError` and every one goes to `onCacheError`.
 */
async function recordSettlement(
  keys: readonly string[],
  entry: SettlementEntry,
  context: SettlementContext,
): Promise<Error | undefined> {
  const key = primaryKey(keys);
  const { cache, archive } = context;
  let firstError: Error | undefined;
  for (const [store, write] of [
    ["settlement cache", cache && (() => recordEntry(cache, keys, entry))],
    [
      "receipt archive",
      archive &&
        (async () => {
          for (const archived of keys) await archive.put(archived, entry);
        }),
    ],
  ] as const) {
    if (!write) continue;
    try {
      await write();
    } catch (failure) {
      const error = asError(failure, `${store} write failed`);
      context.onCacheError?.(error, key);
      firstError ??= error;
    }
  }
  return firstError;
}

/** The two-phase caller's decision: settle, or stop with this rejection. */
type PhaseDecision = { settle: true } | { settle: false; outcome: RejectedOutcome };

/**
 * One request's two-phase handshake. The settlement path calls `ready()` once
 * the payment is verified, admitted and locked, which hands the payment to
 * the caller and starts the handler's deadline, and then waits for
 * `decision`.
 */
type SettlementPhase = {
  ready(validityMs: number): void;
  decision: Promise<PhaseDecision>;
};

/** A two-phase request's handshake and the payment's validity window. */
type TwoPhaseStep = { phase: SettlementPhase; validityMs: number };

/**
 * A two-phase payment that was not settled. The payment is still unspent,
 * so a duplicate that waited on it is told to send it again.
 */
function notSettled(reason: AbandonReason | "lock-lost", detail: string): RejectedOutcome {
  return gateRejection("payment-not-settled", `${reason}: ${detail}`, {
    headers: { "retry-after": "1" },
  });
}

const ABANDONED_DETAIL: Record<AbandonReason, string> = {
  "handler-threw": "the route handler threw, so the payment was not settled",
  "handler-failed":
    "the route handler answered with a failure status, so the payment was not settled",
  "response-too-large":
    "the route's response was larger than the gate holds, so the payment was not settled",
  "client-closed":
    "the client went away before the response was ready, so the payment was not settled",
};

/**
 * The handler outlived the payment's validity window. Settling now would
 * likely fail on chain, and settling late is what the window forbids.
 */
function handlerTimeout(validityMs: number): RejectedOutcome {
  return gateRejection(
    "handler-timeout",
    `the route handler ran longer than the payment's ${Math.round(validityMs / 1000)}s validity window, so the payment was not settled`,
  );
}

/**
 * Hands the payment to a two-phase caller and waits for its decision. Returns
 * the rejection to answer with when the payment must not settle, or
 * undefined to settle. A lock that lapsed while the handler ran means
 * another process may already settle this payment, so it is never settled
 * here.
 */
async function awaitPhase(
  twoPhase: TwoPhaseStep | undefined,
  keeper: LockKeeper | undefined,
): Promise<RejectedOutcome | undefined> {
  if (!twoPhase) return undefined;
  twoPhase.phase.ready(twoPhase.validityMs);
  const decision = await twoPhase.phase.decision;
  if (!decision.settle) return decision.outcome;
  if (keeper?.lost()) {
    return notSettled(
      "lock-lost",
      "the settlement lock lapsed while the route handler ran, so the payment was not settled",
    );
  }
  return undefined;
}

/** What the request-level code hands the settlement path besides the payment. */
type SettlementSteps = {
  /** The headers of a fresh 402, for a refused payment to carry. */
  freshChallengeHeaders: () => Promise<Record<string, string>>;
  /** Set when only a replay is allowed (an expired quote); returns the answer otherwise. */
  replayOnly?: () => Promise<GateOutcome>;
  /** Local checks before `/verify`: a rejection, or undefined to go on. */
  prevalidate?: () => Promise<RejectedOutcome | undefined>;
  /**
   * The client's x402 payment identifier (#153), already validated. Looked
   * up only after `/verify`, scoped to the verified payer.
   */
  paymentId?: string;
  /** Set for `gate.authorize`: settle only after the caller decides (#152). */
  twoPhase?: TwoPhaseStep;
  /** The paid work, run just before `/settle`; see {@link BeforeSettle}. */
  beforeSettle?: BeforeSettle;
  /** Told the outcome of the attempt this request owns, for the observer (#106). */
  report?: AttemptReporter;
};

async function settleWithHandler<TPayment>(
  payment: TPayment,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  handler: Handler<TPayment>,
  context: SettlementContext,
  steps: SettlementSteps,
): Promise<GateOutcome> {
  const {
    freshChallengeHeaders,
    replayOnly,
    prevalidate,
    beforeSettle,
    report,
    paymentId,
    twoPhase,
  } = steps;
  // A payment that already settled is answered from the cache before it is
  // verified again: on chain its authorization nonce is spent, so a second
  // verify fails and the retry would get a 402 instead of its receipt (#284).
  // The binding checks in toOutcome still apply to the cached receipt.
  const knownNonce = await handler.idempotencyKey?.({ payment });
  if (knownNonce !== undefined) {
    const knownKey = `${model}:${knownNonce}`;
    const pending = context.inFlight.get(knownKey);
    if (pending) {
      return toOutcome(await awaitPending(pending), offer, model, method, true, context);
    }
    // The cache first, then the durable archive for a payment whose cache
    // entry has expired (#162). Either hit goes through toOutcome's offer
    // and method binding: a hit for another offer is a 409, never a replay.
    const cached = (await context.cache?.get(knownKey)) ?? (await readArchive(knownKey, context));
    if (cached) {
      const replay: SettlementResult = {
        ok: true,
        receipt: cached.receipt,
        method: cached.method,
        replayed: true,
      };
      return toOutcome(replay, offer, model, method, false, context);
    }
  }
  // The caller allows only a replay here (an expired quote): a payment that
  // has not settled is never verified or settled under it.
  if (replayOnly) {
    return replayOnly();
  }
  // Local checks run after the replay lookup, so a settled payment whose
  // authorization has since expired still gets its receipt, and before
  // /verify, so a payment that cannot pass costs no facilitator call (#159).
  const refused = await prevalidate?.();
  if (refused) return reported(report, refused);

  let verification:
    | { valid: true; payer: string; nonce: string }
    | { valid: false; reason: string };
  try {
    verification = await withDeadline(
      handler.verify({ payment, offer }),
      "verify",
      context.facilitatorTimeoutMs,
    );
  } catch (error) {
    // Nothing has settled yet, so a retry is always safe here. Only failures
    // the facilitator client classified as unavailability become a 503; any
    // other error is a defect and propagates (Directive 4).
    if (error instanceof FacilitatorDeadlineError) {
      return reported(
        report,
        facilitatorUnavailable(
          `facilitator /verify did not answer within ${error.timeoutMs}ms`,
          context.facilitatorRetryAfter,
        ),
      );
    }
    if (isFacilitatorUnavailable(error)) {
      return reported(report, facilitatorUnavailable(error.message, context.facilitatorRetryAfter));
    }
    report?.(undefined);
    throw error;
  }
  if (!verification.valid) {
    // A fresh challenge rides along, so the agent can sign again without a
    // second unpaid request (#161, consistent with #43's 402).
    return reported(
      report,
      gateRejection("payment-invalid", "the payment was refused", {
        upstreamReason: verification.reason,
        headers: await freshChallengeHeaders(),
      }),
    );
  }
  // The cache lookup above used the derived nonce; a facilitator whose verify
  // disagrees with it would store under a key retries never look up.
  if (knownNonce !== undefined && verification.nonce !== knownNonce) {
    return reported(
      report,
      gateRejection(
        "facilitator-invalid-response",
        "facilitator verify returned a nonce that differs from its idempotency key",
      ),
    );
  }

  // The model is part of the key because two models can derive the same
  // nonce from the same header value. A payment identifier adds a second key
  // (#153), scoped to the verified payer: a re-signed envelope has a new
  // digest but the same id, and both keys lead to the same settlement.
  const key = `${model}:${verification.nonce}`;
  const keys =
    paymentId === undefined
      ? [key]
      : [key, paymentIdentifierKey(model, verification.payer, paymentId)];

  // A request that arrives while the same payment is being settled waits for
  // that settlement instead of starting a second one. The map is read and
  // written with no await in between, so two requests cannot both miss it.
  for (const candidate of keys) {
    const pending = context.inFlight.get(candidate);
    if (pending) {
      return toOutcome(await awaitPending(pending), offer, model, method, true, context);
    }
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
    keys,
    context,
    twoPhase,
    beforeSettle,
  );
  for (const claimed of keys) context.inFlight.set(claimed, attempt);
  // While the outcome of /settle is unknown the slot stays taken, so every
  // retry in this process shares the held attempt instead of settling again.
  let hold: SettlementHold | undefined;
  try {
    const result = await attempt;
    if (!result.ok && result.hold) hold = result.hold;
    const outcome = await toOutcome(result, offer, model, method, false, context);
    // A handler that refuses at settle time (an mpp-channel voucher that lost
    // a race, for example) gets the same fresh challenge a refusal at verify
    // time carries.
    if (outcome.kind === "rejected" && outcome.code === "payment-invalid" && !outcome.headers) {
      return reported(report, { ...outcome, headers: await freshChallengeHeaders() });
    }
    return reported(report, outcome);
  } catch (error) {
    if (error instanceof AmbiguousSettlementFailure) hold = error.hold;
    report?.(undefined);
    throw unwrapFailure(error);
  } finally {
    const clear = (): void => {
      for (const claimed of keys) {
        if (context.inFlight.get(claimed) === attempt) context.inFlight.delete(claimed);
      }
    };
    if (hold) {
      void hold.done.then(clear);
    } else {
      clear();
    }
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
  keys: readonly string[],
  context: SettlementContext,
  twoPhase?: TwoPhaseStep,
  beforeSettle?: BeforeSettle,
): Promise<SettlementResult> {
  const servicePolicy = context.servicePolicy;
  const settle = (): Promise<SettlementResult> =>
    settleOnce(
      payment,
      offer,
      model,
      method,
      handler,
      verification,
      keys,
      context,
      twoPhase,
      beforeSettle,
    );
  if (!servicePolicy) {
    return settle();
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
    return settle();
  }

  let result: SettlementResult;
  try {
    result = await settle();
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
  context: Pick<SettlementContext, "offerReceipt">,
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
    headers:
      context.offerReceipt && result.receipt.receipt.model === "x402"
        ? await settlementHeadersFor(result.receipt, context)
        : settlementHeaders(result.receipt),
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
  keys: readonly string[],
  context: SettlementContext,
  twoPhase?: TwoPhaseStep,
  beforeSettle?: BeforeSettle,
): Promise<SettlementResult> {
  const { cache } = context;
  const key = primaryKey(keys);
  const record = (): Promise<SettlementResult> =>
    settleAndRecord(
      payment,
      offer,
      model,
      method,
      handler,
      verification,
      keys,
      context,
      beforeSettle,
    );

  const cached = await settledEntry(keys, context);
  if (cached) {
    return replayFor(cached, verification.payer);
  }

  if (!cache?.acquire || !cache.release || !cache.renew) {
    const stop = await awaitPhase(twoPhase, undefined);
    if (stop) return { ok: false, outcome: stop };
    return record();
  }

  const held = await acquireAll(cache as LockingSettlementCache, keys, context.lockTtlMs);
  if (!held) {
    return { ok: false, outcome: context.settlementInProgress };
  }
  const { keeper, release } = held;

  let result: SettlementResult;
  try {
    // Another process may have settled and released between our miss and
    // our lock, so look again now that we hold it.
    const settledElsewhere = await settledEntry(keys, context);
    if (settledElsewhere) {
      result = replayFor(settledElsewhere, verification.payer);
    } else {
      // Two-phase: the lock is held and renewed while the route handler runs.
      const stop = await awaitPhase(twoPhase, keeper);
      result = stop ? { ok: false, outcome: stop } : await record();
    }
  } catch (error) {
    if (error instanceof AmbiguousSettlementFailure) {
      holdLock(error.hold, keeper, release, key, context);
      throw error;
    }
    keeper.stop();
    await releaseOrThrow(release, key, error);
    throw error;
  }
  if (!result.ok && result.hold) {
    // The payment may still land. Releasing the lock, or letting it lapse,
    // would let a retry in another process settle it a second time.
    holdLock(result.hold, keeper, release, key, context);
    return result;
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

/** The key errors are reported under: the envelope digest, which every payment has. */
function primaryKey(keys: readonly string[]): string {
  const [first] = keys;
  if (first === undefined) throw new TypeError("a settlement needs at least one key");
  return first;
}

/**
 * The settlement already recorded for this payment, found after `/verify`.
 * Every key is read from the cache. A payment-identifier key is also read
 * from the archive, because a re-signed envelope's new digest was never
 * looked up there before `/verify`; the digest key already was.
 */
async function settledEntry(
  keys: readonly string[],
  context: SettlementContext,
): Promise<SettlementEntry | undefined> {
  for (const key of keys) {
    const entry = await context.cache?.get(key);
    if (entry) return entry;
  }
  for (const key of keys.slice(1)) {
    const entry = await readArchive(key, context);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * A recorded settlement found after `/verify`. Every key embeds the payer
 * (the digest through the signed envelope, a payment id explicitly), so a
 * receipt naming anyone else means the store returned an entry this payment
 * does not own. It is refused, never replayed.
 */
function replayFor(entry: SettlementEntry, payer: string): SettlementResult {
  if (entry.receipt.receipt.payer !== payer) {
    return { ok: false, outcome: OFFER_MISMATCH };
  }
  return { ok: true, receipt: entry.receipt, method: entry.method, replayed: true };
}

/**
 * Writes the entry under every key, atomically when the cache can. A single
 * key is a plain `set`, as it was before payment identifiers.
 */
async function recordEntry(
  cache: SettlementCache,
  keys: readonly string[],
  entry: SettlementEntry,
): Promise<void> {
  if (keys.length > 1 && cache.setMany) {
    await cache.setMany(keys, entry);
    return;
  }
  for (const key of keys) await cache.set(key, entry);
}

/**
 * Takes the settlement lock on every key, each renewed while held. If any
 * key is already held, the ones taken are released and the payment is in
 * progress elsewhere. The returned keeper and release cover all of them.
 */
async function acquireAll(
  cache: LockingSettlementCache,
  keys: readonly string[],
  ttlMs: number,
): Promise<{ keeper: LockKeeper; release: () => Promise<boolean> } | false> {
  const held: Array<{ key: string; lock: SettlementLock }> = [];
  const releaseHeld = async (): Promise<boolean> => {
    let all = true;
    let failure: unknown;
    let failed = false;
    for (const { key, lock } of held) {
      try {
        if (!(await cache.release(key, lock))) all = false;
      } catch (releaseFailure) {
        // Keep releasing the others, then report the first failure.
        if (!failed) failure = releaseFailure;
        failed = true;
      }
    }
    if (failed) throw failure;
    return all;
  };

  for (const key of keys) {
    const lock = await cache.acquire(key, ttlMs);
    if (!lock) {
      await releaseHeld();
      return false;
    }
    held.push({ key, lock });
  }

  const keepers = held.map(({ key, lock }) =>
    keepLockAlive(cache.renew.bind(cache), key, lock, ttlMs),
  );
  return {
    keeper: {
      stop: () => {
        for (const keeper of keepers) keeper.stop();
      },
      lost: () => keepers.some((keeper) => keeper.lost()),
      error: () => keepers.find((keeper) => keeper.error())?.error(),
    },
    release: releaseHeld,
  };
}

/**
 * Keeps renewing the settlement lock for a held payment and releases it when
 * the hold ends. By then a late success has been written to the cache, so a
 * retry replays it. A lock lost or not released during the hold goes to
 * `onCacheError`: duplicate protection across processes may have lapsed.
 */
function holdLock(
  hold: SettlementHold,
  keeper: LockKeeper,
  release: () => Promise<boolean>,
  key: string,
  context: SettlementContext,
): void {
  void hold.done.then(async () => {
    keeper.stop();
    let released = false;
    try {
      released = await release();
    } catch (releaseFailure) {
      report(context.onCacheError, asError(releaseFailure, "settlement lock release failed"), key);
      return;
    }
    if (keeper.lost() || !released) {
      report(context.onCacheError, keeper.error() ?? new Error(LOCK_LOST_MESSAGE), key);
    }
  });
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
  keys: readonly string[],
  context: SettlementContext,
  beforeSettle?: BeforeSettle,
): Promise<SettlementResult> {
  // Settle-after-success (#206): the paid work runs here, once per payment,
  // after verification, the service policy and the settlement lock, and
  // before /settle. Work that fails leaves the payment unsettled and uncached.
  if (beforeSettle && !(await beforeSettle())) {
    return { ok: false, outcome: WORK_FAILED };
  }
  // The hold starts with the call, so it bounds how long after sending the
  // payment can stay ambiguous. A definite answer in time ends it at once.
  const hold = startHold(context.ambiguousHoldMs);
  let settlement: HandlerSettlement;
  try {
    settlement = await withDeadline(
      handler.settle({
        payment,
        offer,
        payer: verification.payer,
        nonce: verification.nonce,
      }),
      "settle",
      context.facilitatorTimeoutMs,
      (late) => {
        void settleLateAnswer(late, hold, offer, model, method, verification, keys, context);
      },
    );
  } catch (error) {
    if (error instanceof FacilitatorDeadlineError) {
      return {
        ok: false,
        hold,
        outcome: settlementUnknownOutcome(
          `facilitator /settle did not answer within ${error.timeoutMs}ms`,
          context.ambiguousHoldMs,
        ),
      };
    }
    if (isPreSendFailure(error)) {
      // The request never left this process: nothing can land.
      hold.end();
      if (isFacilitatorUnavailable(error)) {
        return {
          ok: false,
          outcome: facilitatorUnavailable(error.message, context.facilitatorRetryAfter),
        };
      }
      throw error;
    }
    // A classified failure after the request may have been sent: answer with
    // the same held 503 as a missed deadline, never a second /settle (#161).
    if (isFacilitatorUnavailable(error) || isOutcomeUnknown(error)) {
      return {
        ok: false,
        hold,
        outcome: settlementUnknownOutcome(error.message, context.ambiguousHoldMs),
      };
    }
    // The facilitator may have received the request and may still submit it.
    throw new AmbiguousSettlementFailure(error, hold);
  }
  hold.end();

  if (!settlement.settled) {
    return {
      ok: false,
      outcome:
        "code" in settlement
          ? channelRefusal(settlement, context)
          : gateRejection("settlement-failed", "the facilitator refused to settle the payment", {
              upstreamReason: settlement.reason,
            }),
    };
  }

  const receipt = await receiptFor(
    settlementRef(settlement),
    offer,
    model,
    method,
    verification,
    context,
  );

  // The payment has settled, so a failed write must not cost the payer the
  // receipt. The error goes on the outcome and to onCacheError instead.
  const cacheError = await recordSettlement(keys, { receipt, method }, context);
  return cacheError
    ? { ok: true, receipt, method, replayed: false, cacheError }
    : { ok: true, receipt, method, replayed: false };
}

function settlementRef(settlement: Extract<HandlerSettlement, { settled: true }>): SettlementRef {
  return "settlement" in settlement
    ? settlement.settlement
    : { kind: "transaction", txHash: settlement.txHash };
}

/**
 * Signs the receipt for a completed settlement.
 *
 * Issue #166: a v2 receipt carries the SHA-256 of the canonical offer the
 * payer accepted, so two offers for the same URL and price with different
 * models or facilitator URLs produce distinguishable receipts, and the HTTP
 * method, so a receipt for GET does not unlock POST. v1 stays the default
 * until the operator switches (see `PaywallDeps.receiptVersion`).
 */
async function receiptFor(
  settlement: SettlementRef,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  verification: { payer: string },
  context: SettlementContext,
): Promise<SignedReceipt> {
  const v2 =
    context.receiptVersion === 2 ? { offerHash: await hashOffer(offer), method } : undefined;
  return signReceipt(
    buildReceipt({
      payer: verification.payer,
      payee: offer.payTo,
      amount: offer.amount,
      asset: offer.asset,
      resource: offer.resource,
      model,
      settlement,
      network: offer.network,
      ...v2,
    }),
    context.signer,
  );
}

/**
 * A `/settle` that missed its deadline can still answer later. A success is
 * written to the cache before the hold ends, so a retry replays the receipt
 * instead of settling the payment again. A definite failure ends the hold so
 * the payment can be tried again. A late transport failure that may have
 * reached the facilitator leaves the hold to run its course. Nothing here
 * throws: the request that timed out has already been answered.
 */
async function settleLateAnswer(
  late: LateAnswer<HandlerSettlement>,
  hold: SettlementHold,
  offer: PaymentOffer,
  model: SettlementModel,
  method: string,
  verification: { payer: string },
  keys: readonly string[],
  context: SettlementContext,
): Promise<void> {
  const key = primaryKey(keys);
  const { cache, archive } = context;
  if (!late.ok) {
    if (isPreSendFailure(late.error)) hold.end();
    return;
  }
  if (late.value.settled && (context.cache || context.archive)) {
    let receipt: SignedReceipt;
    try {
      receipt = await receiptFor(
        settlementRef(late.value),
        offer,
        model,
        method,
        verification,
        context,
      );
    } catch (error) {
      report(context.onCacheError, asError(error, "late settlement receipt failed"), key);
      return;
    }
    // Both stores are written and every failure is reported. The hold only
    // ends once a retry can find the receipt: the cache when there is one
    // (it is what retries read first), otherwise the archive.
    const findable = context.cache ? "settlement cache" : "receipt archive";
    let recorded = true;
    for (const [store, write] of [
      ["settlement cache", cache && (() => recordEntry(cache, keys, { receipt, method }))],
      [
        "receipt archive",
        archive &&
          (async () => {
            for (const archived of keys) await archive.put(archived, { receipt, method });
          }),
      ],
    ] as const) {
      if (!write) continue;
      try {
        await write();
      } catch (error) {
        // The payment landed but a retry may not find its receipt, and after
        // the hold it would settle again. Keep holding and tell the operator.
        report(context.onCacheError, asError(error, `late ${store} write failed`), key);
        if (store === findable) recorded = false;
      }
    }
    if (!recorded) return;
  }
  hold.end();
}

const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding"]);

/** One payment option as a request sees it: its offer and the requirements it advertises. */
type OfferedOption = {
  option: ResolvedPaymentOption;
  offer: PaymentOffer;
  requirements: PaymentRequirements;
};

/** The offer and advertised requirements of each option, for one request. */
function offerOptions(
  options: readonly ResolvedPaymentOption[],
  resource: string,
  dynamicAmount: string | undefined,
  models: SettlementModel[],
  quote: string | undefined,
): OfferedOption[] {
  return options.map((option) => {
    // Only a single-option paywall can be dynamic; its price is per request.
    const amount = typeof option.amount === "string" ? option.amount : (dynamicAmount as string);
    const offer: PaymentOffer = {
      resource,
      amount,
      asset: option.asset,
      payTo: option.payTo,
      network: option.network,
      models,
      facilitatorUrl: option.facilitatorUrl,
      quote,
    };
    return { option, offer, requirements: toPaymentRequirements(offer, option.terms) };
  });
}

/**
 * How long, in seconds, the gate keeps honouring the terms of one 402: the
 * route's `maxTimeoutSeconds`, and for a dynamic price no longer than the
 * quote it priced. A signed offer may not outlive it.
 */
function offerAcceptanceWindow(config: PaywallConfig): number {
  const timeout = config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (typeof config.amount !== "function") return timeout;
  return Math.min(timeout, config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS);
}

/**
 * The 402 for a request with no payment. It carries the x402 V2
 * `PaymentRequired` in the PAYMENT-REQUIRED header and as the JSON body.
 * When the route accepts mpp-charge, the MPP challenge `mppx` built (its
 * `WWW-Authenticate: Payment ...` header) is added alongside, so an agent can
 * answer with either protocol.
 */
async function paymentRequired(
  offered: readonly OfferedOption[],
  request: TollwayRequest,
  acceptedModels: SettlementModel[],
  mppChargeHandler: MppChargeHandler | undefined,
  config: PaywallConfig,
  quote: string | undefined,
  context: Pick<SettlementContext, "offerReceipt" | "clock">,
): Promise<Extract<GateOutcome, { kind: "payment-required" }>> {
  const [primary] = offered;
  if (!primary) throw new TypeError("a paywall offers at least one payment option");
  const offer = primary.offer;
  const challenge: PaymentRequired = {
    x402Version,
    resource: {
      url: offer.resource,
      ...(config.discovery ? discoveryResourceInfo(config.discovery) : {}),
    },
    // Every option, in the service's preference order (#158).
    accepts: offered.map((option) => option.requirements),
  };
  // Every route declares payment-identifier (#153); bazaar discovery (#154)
  // and offer-receipt (#172) are published only when a route opts in.
  const extensions: Record<string, unknown> = {
    ...paymentIdentifierExtensions(config.paymentIdentifier?.required ?? false),
    ...(config.discovery ? discoveryExtensions(config.discovery, request) : {}),
  };
  // Offers are signed only for requirements the gate settles itself.
  if (context.offerReceipt && acceptedModels.includes("x402")) {
    extensions[OFFER_RECEIPT_EXTENSION_KEY] = await context.offerReceipt.offers(
      challenge.resource?.url ?? offer.resource,
      challenge.accepts,
      context.clock(),
    );
  }
  challenge.extensions = extensions;
  const headers: Record<string, string> = {
    [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(challenge),
  };
  if (quote !== undefined) headers[TOLLWAY_QUOTE_HEADER] = quote;
  // MPP charges one amount of one asset, so it is offered on the primary
  // (first) option only.
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
 * Adds the MPP channel challenge to a 402 (#173). A channel challenge names
 * one channel contract, so it is only issued to an agent that says which
 * channel it pays from, in TOLLWAY-CHANNEL. The handler checks the channel on
 * chain first; a channel that fails is refused, not challenged.
 */
async function withChannelChallenge(
  outcome: Extract<GateOutcome, { kind: "payment-required" }>,
  offer: PaymentOffer,
  request: TollwayRequest,
  acceptedModels: SettlementModel[],
  mppChannelHandler: MppChannelHandler | undefined,
  context: Pick<SettlementContext, "facilitatorRetryAfter" | "settlementInProgress">,
): Promise<GateOutcome> {
  const channelId = readHeader(request.headers, TOLLWAY_CHANNEL_HEADER);
  if (!channelId || !mppChannelHandler || !acceptedModels.includes("mpp-channel")) {
    return outcome;
  }
  const mppChannel = await mppChannelHandler.challenge({
    offer,
    request: { method: request.method, url: request.url },
    channelId: channelId.trim(),
  });
  if (!mppChannel.ok) return channelRefusal(mppChannel, context);
  const headers = { ...outcome.headers };
  for (const [name, value] of Object.entries(mppChannel.headers)) {
    if (BODY_HEADERS.has(name.toLowerCase())) continue;
    // Both MPP methods answer in WWW-Authenticate; HTTP allows several
    // challenges in one header, separated by commas.
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing && name.toLowerCase() === "www-authenticate") {
      headers[existing] = `${headers[existing]}, ${value}`;
    } else {
      headers[name] = value;
    }
  }
  return { ...outcome, headers };
}

/**
 * The rejection for an mpp-channel refusal. The handler names the gate code;
 * the reason starts with the channel code listed in docs/mpp-channels.md.
 */
function channelRefusal(
  refusal: MppChannelRefusal,
  context: Pick<SettlementContext, "facilitatorRetryAfter" | "settlementInProgress">,
): RejectedOutcome {
  switch (refusal.code) {
    case "payment-invalid":
      return gateRejection("payment-invalid", "the payment was refused", {
        upstreamReason: refusal.reason,
      });
    case "channel-refused":
      return gateRejection("channel-refused", refusal.reason);
    case "channel-rate-limited":
      return gateRejection("channel-rate-limited", refusal.reason, {
        headers: { "retry-after": retryAfterSeconds(refusal.retryAfterMs ?? 1000) },
      });
    case "settlement-in-progress":
      return { ...context.settlementInProgress, reason: refusal.reason };
    case "facilitator-unavailable":
      return facilitatorUnavailable(refusal.reason, context.facilitatorRetryAfter);
  }
}

/**
 * The payment observer hooks (#106), shared by the HTTP gate and
 * {@link createPaidCall} so both report a settlement the same way. Returns
 * `settleObserved`, which runs one settlement with a reporter that measures
 * its latency from `clock`.
 */
function attemptObserver(
  deps: Pick<PaywallDeps, "observer" | "onObserverError">,
  clock: () => number,
): (
  settle: (report: AttemptReporter | undefined) => Promise<GateOutcome>,
  offer: PaymentOffer,
  model: SettlementModel,
) => Promise<GateOutcome> {
  /** Observer hooks are diagnostic; neither they nor their errors change a payment. */
  function reportObserverError(error: unknown): void {
    try {
      deps.onObserverError?.(error);
    } catch (hookError) {
      // A second failure in the error hook also ends here: the gate must
      // still answer with the settlement it already decided.
      void hookError;
    }
  }

  function observeOutcome(
    outcome: GateOutcome | undefined,
    offer: PaymentOffer,
    model: SettlementModel,
    startedAt: number,
  ): void {
    const observer = deps.observer;
    if (!observer) return;
    const endedAt = clock();
    const latencyMs = Math.max(0, endedAt - startedAt);
    const at = new Date(endedAt).toISOString();

    if (outcome?.kind === "settled" && !outcome.replayed) {
      const receipt = outcome.receipt.receipt;
      try {
        observer.record({
          payer: receipt.payer,
          payee: receipt.payee,
          model: receipt.model,
          amount: receipt.amount,
          asset: receipt.asset,
          latencyMs,
          outcome: "settled",
          at,
        });
      } catch (error) {
        reportObserverError(error);
      }
      try {
        // Delivery is deliberately not awaited: webhook sends must not hold
        // up the paid response. The rejection handler keeps it unobserved
        // only in the sense of latency, never in the sense of error handling.
        void Promise.resolve(
          observer.emit({
            id: receipt.id,
            type: "receipt.created",
            at,
            data: {
              receiptId: receipt.id,
              resource: receipt.resource,
              model: receipt.model,
              amount: receipt.amount,
            },
          }),
        ).catch(reportObserverError);
      } catch (error) {
        reportObserverError(error);
      }
      return;
    }

    if (outcome === undefined || outcome.kind === "rejected") {
      // A thrown or rejected attempt has no settled receipt, and a failed
      // verify has no verified payer. Keeping payer as an empty
      // string rather than making it optional preserves PaymentMetric's
      // shape for every consumer (see the justification in issue #106).
      try {
        observer.record({
          payer: "",
          payee: offer.payTo,
          model,
          amount: offer.amount,
          asset: offer.asset,
          latencyMs,
          outcome: "failed",
          at,
        });
      } catch (error) {
        reportObserverError(error);
      }
    }
  }

  /**
   * Runs one settlement with a reporter that measures latency (verify plus
   * settle) from the injected clock. The attempt calls it at most once, and
   * only when this request owns the outcome.
   */
  function settleObserved(
    settle: (report: AttemptReporter | undefined) => Promise<GateOutcome>,
    offer: PaymentOffer,
    model: SettlementModel,
  ): Promise<GateOutcome> {
    if (!deps.observer) return settle(undefined);
    const startedAt = clock();
    return settle((outcome) => observeOutcome(outcome, offer, model, startedAt));
  }
  return settleObserved;
}

/** The services a paid call that is not an HTTP request uses. */
export type PaidCallDeps = Omit<
  PaywallDeps,
  "mppChargeHandler" | "router" | "onPriceError" | "facilitator" | "paymentPrevalidation"
> & {
  /** Verifies and settles the call's x402 payments. A paid call has one price, so one facilitator. */
  facilitator: FacilitatorClient;
};

/**
 * Checks the dependencies shared by the HTTP gate and {@link createPaidCall}
 * and builds the settlement context both settle through, so replay, locking,
 * receipt signing and offer binding have one implementation.
 */
function settlementContext(
  deps: Omit<PaidCallDeps, "facilitator">,
  inFlight: Map<string, Promise<SettlementResult>>,
): SettlementContext {
  assertCompleteLocking(deps.cache);
  if (deps.servicePolicy) validateServicePolicy(deps.servicePolicy);
  const facilitatorTimeoutMs = deps.facilitatorTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(facilitatorTimeoutMs) || facilitatorTimeoutMs <= 0) {
    throw new TypeError("facilitatorTimeoutMs must be a positive integer number of milliseconds");
  }
  const ambiguousHoldMs = deps.ambiguousSettlementHoldMs ?? DEFAULT_AMBIGUOUS_HOLD_MS;
  if (!Number.isSafeInteger(ambiguousHoldMs) || ambiguousHoldMs <= facilitatorTimeoutMs) {
    throw new TypeError(
      "ambiguousSettlementHoldMs must be an integer number of milliseconds longer than facilitatorTimeoutMs",
    );
  }
  const clock = deps.clock ?? Date.now;
  const servicePolicyStore =
    deps.servicePolicy && (deps.servicePolicyStore ?? createInMemoryServicePolicyStore());
  if (deps.receiptVersion !== undefined && deps.receiptVersion !== 1 && deps.receiptVersion !== 2) {
    throw new TypeError(`receiptVersion must be 1 or 2, got ${String(deps.receiptVersion)}`);
  }
  const inProgressSeconds = positiveSeconds(
    deps.retryAfterSeconds?.settlementInProgress,
    "retryAfterSeconds.settlementInProgress",
  );
  const unavailableSeconds = positiveSeconds(
    deps.retryAfterSeconds?.facilitatorUnavailable,
    "retryAfterSeconds.facilitatorUnavailable",
  );
  return {
    signer: deps.signer,
    receiptVersion: deps.receiptVersion ?? 1,
    cache: deps.cache,
    onCacheError: deps.onCacheError,
    ...(deps.receiptArchive ? { archive: deps.receiptArchive } : {}),
    ...(deps.onArchiveError ? { onArchiveError: deps.onArchiveError } : {}),
    ...(deps.onServicePolicyError ? { onServicePolicyError: deps.onServicePolicyError } : {}),
    inFlight,
    lockTtlMs: deps.settlementLockTtlMs ?? DEFAULT_SETTLEMENT_LOCK_TTL_MS,
    facilitatorTimeoutMs,
    ambiguousHoldMs,
    settlementInProgress: settlementInProgress(inProgressSeconds),
    facilitatorRetryAfter: String(unavailableSeconds),
    clock,
    ...(deps.servicePolicy && servicePolicyStore
      ? { servicePolicy: { policy: deps.servicePolicy, store: servicePolicyStore } }
      : {}),
  };
}

/**
 * What a paid call that is not an HTTP request charges, such as an MCP tool
 * call (#206). The price is fixed: a dynamic price reads the HTTP request,
 * and there is none here.
 */
export type PaidCallConfig = {
  /** Price as an integer string in the asset's smallest unit. */
  amount: string;
  asset: string;
  /** Stellar address the payment settles to. Tollway never sits in between. */
  payTo: string;
  network: StellarNetwork;
  /**
   * The stable resource id the receipt names, for example
   * `mcp://tool/get-quote`. A receipt for one resource never unlocks another.
   */
  resource: string;
  /** Accepted models. Only x402 can be paid on a paid call; defaults to x402. */
  models?: SettlementModel[];
  facilitatorUrl?: string;
  /** x402: how long the payment stays valid, in seconds. Defaults to 60. */
  maxTimeoutSeconds?: number;
  /** x402: scheme-specific data, sent as `PaymentRequirements.extra`. */
  extra?: Record<string, unknown>;
  /** Published on the challenge's `resource`, as x402 allows. */
  description?: string;
  mimeType?: string;
};

/** One x402 payment for a paid call, and the work it pays for. */
export type PaidCallSettleInput = {
  /** The agent's x402 V2 `PaymentPayload`, already schema-checked by the transport. */
  payment: X402Payload;
  /**
   * Names the operation in v2 receipts and binds cached receipts to it, the
   * way the HTTP method does for a route. An MCP tool call uses `tools/call`.
   */
  method: string;
  /**
   * The paid work, run after the payment is verified and before it settles.
   * Resolve `false` (or throw) and the payment is not settled. It runs only
   * for the call that settles: a replay of a settled payment, or a call that
   * shares a settlement already in progress, gets the receipt without it.
   */
  beforeSettle?: () => Promise<boolean>;
};

/** A payment gate for one paid operation that is not an HTTP route. */
export type PaidCall = {
  /** The offer every payment for this call is checked and bound against. */
  readonly offer: PaymentOffer;
  /** The x402 V2 `PaymentRequired` challenge, with an optional error message. */
  paymentRequired(error?: string): PaymentRequired;
  /**
   * Verifies, runs `beforeSettle`, settles and signs the receipt through the
   * same settlement path as the HTTP gate: one payment settles at most once,
   * concurrent copies share one settlement, and a cached receipt is returned
   * only for this offer and method.
   */
  settle(input: PaidCallSettleInput): Promise<GateOutcome>;
};

/**
 * Builds a gate for a paid operation that has no HTTP request, such as an
 * MCP tool call (#206). It shares the HTTP gate's settlement path and
 * settlement cache format, and adds settle-after-success through
 * `beforeSettle`.
 */
export function createPaidCall(config: PaidCallConfig, deps: PaidCallDeps): PaidCall {
  parsePriceAmount(config.amount, "amount");
  if (config.resource.length === 0) {
    throw new TypeError("resource must be a non-empty string");
  }
  const models = config.models ?? ["x402"];
  if (!models.includes("x402")) {
    throw new TypeError("a paid call settles x402 payments, so models must include x402");
  }
  const context = settlementContext(deps, new Map());
  const settleObserved = attemptObserver(deps, context.clock);
  const offer: PaymentOffer = {
    resource: config.resource,
    amount: config.amount,
    asset: config.asset,
    payTo: config.payTo,
    network: config.network,
    models,
    ...(config.facilitatorUrl === undefined ? {} : { facilitatorUrl: config.facilitatorUrl }),
  };
  const requirements = toPaymentRequirements(offer, {
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: config.extra,
  });

  const paymentRequired = (error?: string): PaymentRequired => ({
    x402Version,
    ...(error === undefined ? {} : { error }),
    resource: {
      url: config.resource,
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
    },
    accepts: [requirements],
  });

  return {
    offer,
    paymentRequired,
    async settle({ payment, method, beforeSettle }) {
      if (payment.x402Version !== x402Version) {
        return gateRejection(
          "payment-malformed",
          `unsupported x402Version ${String(payment.x402Version)}; this gate speaks x402 version ${x402Version}`,
        );
      }
      const x402: X402Payment = { model: "x402", payload: payment };
      // Reported to the observer like an HTTP payment. The latency includes
      // the paid work, which runs between verify and settle.
      return settleObserved(
        (report) =>
          settleWithHandler(x402, offer, "x402", method, deps.facilitator, context, {
            // A refused payment carries a fresh challenge, as on an HTTP route.
            freshChallengeHeaders: async () => ({
              [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(paymentRequired()),
            }),
            ...(beforeSettle ? { beforeSettle } : {}),
            ...(report ? { report } : {}),
          }),
        offer,
        "x402",
      );
    },
  };
}

/**
 * Builds the gate from a paywall config. It settles x402 per-request,
 * mpp-charge, and mpp-channel vouchers. See docs/design.md, "Build plan",
 * Phases 1 and 2.
 */
export function createPaywall(config: PaywallConfig, deps: PaywallDeps): PaywallGate {
  return createPaywallWithInFlight(config, deps, new Map());
}

/** Reads an optional `Retry-After` setting: a positive whole number of seconds, default 1. */
function positiveSeconds(value: number | undefined, name: string): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer number of seconds`);
  }
  return value;
}

/** Internal constructor used by route tables to share duplicate coordination. */
export function createPaywallWithInFlight(
  config: PaywallConfig,
  deps: PaywallDeps,
  inFlight: Map<string, Promise<InFlightSettlementResult>>,
): PaywallGate {
  validateDynamicPriceConfig(config);
  const maxResponseBytes = config.twoPhase?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("twoPhase.maxResponseBytes must be a positive integer number of bytes");
  }
  const isFailureStatus =
    config.twoPhase?.isFailureStatus ?? ((status: number) => status >= 500 && status <= 599);
  if (config.discovery) checkDiscoveryDeclaration(config.discovery);
  const acceptedModels = config.models ?? ["x402"];
  // The offer-receipt extension (#172) answers an HTTP 402, so only the gate
  // adds it to the shared settlement context.
  const offerReceipt = config.offerReceipt
    ? createOfferReceiptIssuer(
        deps.signer,
        config.offerReceipt === true ? {} : config.offerReceipt,
        offerAcceptanceWindow(config),
      )
    : undefined;
  const context: SettlementContext = {
    ...settlementContext(deps, inFlight),
    ...(offerReceipt ? { offerReceipt } : {}),
  };
  const clock = context.clock;
  const options = resolvePaymentOptions(config, deps.facilitator, acceptedModels);
  const prevalidation = deps.paymentPrevalidation ?? {};
  const maxSignatureLength =
    prevalidation.maxPaymentSignatureLength ?? DEFAULT_MAX_PAYMENT_SIGNATURE_LENGTH;
  if (!Number.isSafeInteger(maxSignatureLength) || maxSignatureLength < 1) {
    throw new TypeError(
      "paymentPrevalidation.maxPaymentSignatureLength must be a positive integer",
    );
  }
  let rejectedTotal = 0;
  const localRejection = async (
    reason: PrevalidationReason,
    resource: string,
    challengeHeaders: () => Promise<Record<string, string>>,
  ): Promise<RejectedOutcome> => {
    rejectedTotal += 1;
    prevalidation.onRejected?.({ reason, resource, rejectedTotal });
    return gateRejection("payment-invalid", "the payment failed local validation", {
      upstreamReason: reason,
      headers: await challengeHeaders(),
    });
  };

  const settleObserved = attemptObserver(deps, clock);

  const run = async (request: TollwayRequest, phase?: SettlementPhase): Promise<GateOutcome> => {
    const method = request.method.toUpperCase();
    const signatureHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    const mppCredential =
      acceptedModels.includes("mpp-charge") || acceptedModels.includes("mpp-channel")
        ? readMppCredential(request.headers)
        : undefined;

    // The x402 payment is decoded before pricing, because a dynamic-price
    // quote comes back inside it, in `accepted.extra.tollwayQuote`.
    let x402Payment: X402Payload | undefined;
    let oversized = false;
    if (signatureHeader && !mppCredential && signatureHeader.length > maxSignatureLength) {
      // Refused before any decoding: a flood of huge headers costs a length
      // comparison each. The 402 still needs the offer, built below.
      oversized = true;
    } else if (signatureHeader && !mppCredential) {
      try {
        x402Payment = decodePaymentSignatureHeader(signatureHeader);
      } catch (error) {
        return gateRejection(
          "payment-malformed",
          `PAYMENT-SIGNATURE is not a base64 x402 PaymentPayload: ${asError(error, "invalid header").message}`,
        );
      }
      if (x402Payment.x402Version !== x402Version) {
        return gateRejection(
          "payment-malformed",
          `unsupported x402Version ${String(x402Payment.x402Version)}; this gate speaks x402 version ${x402Version}`,
        );
      }
    }

    // The id is only read here; it is looked up after /verify, because it is
    // client-chosen and must never stand in for a verified payment.
    let paymentId: string | undefined;
    if (x402Payment) {
      const read = readPaymentIdentifier(x402Payment, config.paymentIdentifier?.required ?? false);
      if (!read.ok) return gateRejection("payment-malformed", read.reason);
      paymentId = read.id;
    }

    const resource = config.resource ?? request.url;
    let dynamicAmount: string | undefined;
    let quote: string | undefined;
    let candidateQuote: string | undefined;
    let quoteExpired = false;
    if (typeof config.amount === "function") {
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
        dynamicAmount = verified.payload.amount;
        quote = candidateQuote;
        quoteExpired = verified.expired;
      } else {
        const priced = await priceRequest(config, request, deps.onPriceError);
        if (!priced.ok) return priced.outcome;
        dynamicAmount = priced.amount;
        quote = await createQuote(
          resource,
          dynamicAmount,
          now,
          config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS,
          config.quoteSecret ?? "",
        );
      }
    }
    const offered = offerOptions(options, resource, dynamicAmount, acceptedModels, quote);
    // The primary option: the one MPP charges, and the only one a dynamic
    // paywall has.
    const primary = offered[0] as OfferedOption;

    const challenge = (): Promise<Extract<GateOutcome, { kind: "payment-required" }>> =>
      paymentRequired(
        offered,
        request,
        acceptedModels,
        deps.mppChargeHandler,
        config,
        quote,
        context,
      );
    // The 402 for a request with no payment: the challenge, plus the channel
    // challenge when the agent names its channel.
    const channelChallenge = async (): Promise<GateOutcome> =>
      withChannelChallenge(
        await challenge(),
        primary.offer,
        request,
        acceptedModels,
        deps.mppChannelHandler,
        context,
      );
    // The challenge a refused payment carries, so the agent can pay again.
    const challengeHeaders = async (): Promise<Record<string, string>> =>
      (await challenge()).headers;

    if (oversized) {
      return localRejection("payment_signature_too_large", resource, challengeHeaders);
    }

    // A dynamic price is only paid against a quote this gate issued: a
    // missing, expired, tampered or mismatched one gets a fresh 402.
    if (typeof config.amount === "function" && candidateQuote !== quote) {
      return channelChallenge();
    }

    // An MPP credential answers an MPP challenge, so the agent has already
    // chosen the model; the router is not asked again. Only a route that
    // accepts mpp-channel looks inside the credential to tell the methods
    // apart; a charge-only route hands it straight to the charge handler,
    // which decodes it once and rejects any other method.
    if (mppCredential) {
      if (acceptedModels.includes("mpp-channel")) {
        const parsed = parseMppChannelCredential(mppCredential);
        const isChannel = parsed.ok || parsed.kind === "invalid-channel";
        if (isChannel || !acceptedModels.includes("mpp-charge")) {
          if (!parsed.ok) {
            return gateRejection("payment-malformed", parsed.reason);
          }
          if (!deps.mppChannelHandler) {
            return gateRejection("handler-not-configured", "mpp-channel handler not configured");
          }
          return settleWithHandler(
            parsed.payment,
            primary.offer,
            "mpp-channel",
            method,
            deps.mppChannelHandler,
            context,
            { freshChallengeHeaders: challengeHeaders },
          );
        }
      }

      if (!deps.mppChargeHandler) {
        return gateRejection("handler-not-configured", "mpp-charge handler not configured");
      }
      const payment: MppChargePayment = { model: "mpp-charge", payload: mppCredential };
      const handler = deps.mppChargeHandler;
      return settleObserved(
        (report) =>
          settleWithHandler(payment, primary.offer, "mpp-charge", method, handler, context, {
            freshChallengeHeaders: challengeHeaders,
            ...(report ? { report } : {}),
            ...(phase ? { twoPhase: { phase, validityMs: validityMs(primary.requirements) } } : {}),
          }),
        primary.offer,
        "mpp-charge",
      );
    }

    if (!x402Payment) {
      return channelChallenge();
    }

    // The payer names the option it chose in `accepted`, which it controls,
    // so nothing is taken from it: it must equal, field for field, one of
    // the requirements this gate advertises, and the matched option's own
    // terms are used from here on (#158).
    const chosen = matchAcceptedOption(offered, x402Payment.accepted);
    if (!chosen) {
      return gateRejection(
        "payment-invalid",
        "the payment's accepted terms match none of this route's payment options",
        { headers: await challengeHeaders() },
      );
    }
    const offer = chosen.offer;

    const decision = deps.router
      ? await deps.router.decide({ counterparty: offer.payTo, resource: offer.resource, offer })
      : ({ model: acceptedModels[0], reason: "default" } as const);

    if (decision.model === "x402") {
      const facilitator = chosen.option.facilitator;
      if (!facilitator) {
        // resolvePaymentOptions refuses an x402 paywall without one, so this
        // is a router that chose x402 for a paywall that does not accept it.
        return gateRejection("handler-not-configured", "no facilitator configured for x402");
      }
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
          offerOptions(options, resource, priced.amount, acceptedModels, fresh),
          request,
          acceptedModels,
          deps.mppChargeHandler,
          config,
          fresh,
          context,
        );
      };
      const payload = x402Payment;
      const prevalidate = async (): Promise<RejectedOutcome | undefined> => {
        const transaction = payload.payload.transaction;
        const check = (latestLedger?: number) =>
          typeof transaction === "string"
            ? checkStellarExactPayment(transaction, chosen.requirements, {
                accepted: payload.accepted,
                maxTransactionLength: maxSignatureLength,
                ...(latestLedger === undefined ? {} : { latestLedger }),
              })
            : ({ valid: false, reason: "invalid_exact_stellar_payload_malformed" } as const);
        let result = check();
        // The ledger is only fetched for a payment that passed everything
        // else, so junk traffic never reaches Stellar RPC.
        if (result.valid && prevalidation.latestLedger) {
          const latest = await prevalidation.latestLedger.latest();
          if (latest !== undefined) result = check(latest);
        }
        return result.valid ? undefined : localRejection(result.reason, resource, challengeHeaders);
      };
      // The mock's payments are not Stellar envelopes; it says so explicitly.
      const prevalidates = facilitator.acceptsMockPayments !== true;
      return settleObserved(
        (report) =>
          settleWithHandler(payment, offer, "x402", method, facilitator, context, {
            freshChallengeHeaders: challengeHeaders,
            ...(quoteExpired ? { replayOnly: freshChallenge } : {}),
            ...(prevalidates ? { prevalidate } : {}),
            ...(report ? { report } : {}),
            ...(paymentId === undefined ? {} : { paymentId }),
            ...(phase ? { twoPhase: { phase, validityMs: validityMs(chosen.requirements) } } : {}),
          }),
        offer,
        "x402",
      );
    }

    // Both MPP models answer with an Authorization: Payment credential.
    return gateRejection(
      "payment-malformed",
      `${decision.model} payments carry an Authorization: Payment credential, not PAYMENT-SIGNATURE`,
    );
  };

  const gate = (request: TollwayRequest): Promise<GateOutcome> => run(request);

  async function authorize(request: TollwayRequest): Promise<AuthorizeOutcome> {
    const control = createPhaseControl();
    // Settled into a value so it never rejects unhandled: settle() rethrows
    // a failure, and any other failure goes to onCacheError below.
    const finished = run(request, control.phase).then(
      (outcome) => ({ ok: true, outcome }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const first = await Promise.race([control.authorized.then(() => undefined), finished]);
    if (first !== undefined) {
      if (!first.ok) throw first.error;
      return first.outcome;
    }

    let called: "settle" | "abandon" | undefined;
    void finished.then((result) => {
      // A failure after abandonment (or a deadline) has no request left to
      // answer, typically a lock release that failed. Tell the operator.
      if (!result.ok && called !== "settle") {
        report(
          deps.onCacheError,
          asError(result.error, "two-phase settlement cleanup failed"),
          `${request.method.toUpperCase()} ${request.url}`,
        );
      }
    });

    return {
      kind: "authorized",
      maxResponseBytes,
      isFailure: (status) => isFailureStatus(status),
      async settle() {
        if (called !== undefined) {
          throw new TypeError(
            called === "settle"
              ? "settle() was already called for this payment"
              : "settle() was called after abandon(); an abandoned payment cannot settle",
          );
        }
        called = "settle";
        control.decide({ settle: true });
        const result = await finished;
        if (!result.ok) throw result.error;
        const outcome = result.outcome;
        if (outcome.kind === "settled" || outcome.kind === "rejected") return outcome;
        throw new TypeError(`a two-phase settlement ended in a ${outcome.kind} outcome`);
      },
      async abandon(reason) {
        if (called === "settle") return;
        if (called === undefined) {
          called = "abandon";
          control.decide({ settle: false, outcome: notSettled(reason, ABANDONED_DETAIL[reason]) });
        }
        // Wait for the lock release, so a retry right after finds it free.
        await finished;
      },
    };
  }

  return Object.assign(gate, { authorize });
}

/** How long a payment stays valid, from the terms it was paid against. */
function validityMs(requirements: PaymentRequirements): number {
  return requirements.maxTimeoutSeconds * 1000;
}

/**
 * The two-phase handshake for one request. `authorized` resolves when the
 * settlement path hands the payment over; from then the handler has the
 * payment's validity window to finish before the payment is abandoned on its
 * behalf. `decide` takes the first decision and ignores the rest.
 */
function createPhaseControl() {
  let markAuthorized: () => void = () => {};
  const authorized = new Promise<void>((resolve) => {
    markAuthorized = resolve;
  });
  let resolveDecision: (decision: PhaseDecision) => void = () => {};
  const decision = new Promise<PhaseDecision>((resolve) => {
    resolveDecision = resolve;
  });
  let decided = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const decide = (next: PhaseDecision): void => {
    if (decided) return;
    decided = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveDecision(next);
  };

  const phase: SettlementPhase = {
    ready(validity) {
      markAuthorized();
      timer = setTimeout(
        () => decide({ settle: false, outcome: handlerTimeout(validity) }),
        validity,
      );
      unrefTimer(timer);
    },
    decision,
  };
  return { phase, authorized, decide };
}
