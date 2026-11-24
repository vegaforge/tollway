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
 * Calls that overlap for the same purchase share one settlement, so an agent
 * that fires the same request twice in parallel pays once.
 *
 * The settler is the seam between this orchestrator and the protocol-
 * specific dance (Soroban auth entry signing for x402, MPP channel
 * commitments, etc.). Tests inject a mock settler; production wires a
 * settler backed by @x402/stellar or @stellar/mpp. Keeping the
 * settler injected means the client itself stays pure orchestration and
 * the test surface is small.
 */

import {
  ChannelOpenFailedError,
  type ChannelOpenSubmission,
  type CounterpartyQuarantine,
  canonicalJson,
  comparePolicyTraces,
  createPolicyEngine,
  decisionFromTrace,
  type ModelRouter,
  type PaymentIntent,
  type PaymentOffer,
  type PolicyEngine,
  type PolicyTrace,
  type PolicyTraceComparison,
  type QuarantineEntry,
  type ReceiptVerifier,
  type RouteDecision,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  type OfferChecks,
  OfferRejectedError,
  runOfferChecks,
  validateOfferChecks,
} from "./offer-checks.js";
import {
  assertOfferForRequest,
  assertReceiptMatchesOffer,
  DEFAULT_RECEIPT_MAX_SKEW_MS,
  OfferNetworkMismatchError,
} from "./receipt-binding.js";
import type { ReceiptStore } from "./receipt-store.js";
import {
  AmbiguousSettlementError,
  MAX_RETRY_AFTER_MS,
  normaliseRetryOptions,
  type RetryOptions,
  SettlementOutcomeError,
  type SignedTerms,
} from "./retry.js";

export {
  AmbiguousSettlementError,
  MAX_RETRY_AFTER_MS,
  type RetryOptions,
  SettlementOutcomeError,
  type SettlementOutcomeKind,
  type SignedTerms,
} from "./retry.js";

/** Events the client emits so callers and observability can follow along. */
export type ClientEvent =
  | { type: "payment"; resource: string; model: SettlementModel; receipt: SignedReceipt }
  /**
   * A call that shared another call's settlement instead of paying. It
   * carries the receipt of the one payment that was made, which the settling
   * call reports as `payment`. Count `payment` events to count payments.
   */
  | {
      type: "payment:deduplicated";
      resource: string;
      model: SettlementModel;
      receipt: SignedReceipt;
    }
  | { type: "skip"; resource: string; reason: string }
  /**
   * Issue #203: a retry attempt is about to run. `attempt` is 1-based
   * and names the attempt being started (so `attempt: 2` is the first
   * retry). `reason` carries the settler-reported cause of the previous
   * failure.
   */
  | { type: "retry"; resource: string; attempt: number; reason: string }
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
  /**
   * A channel settler opened or closed a payment channel. The client never
   * opens channels itself: a settler reports these through
   * `ClientSettler.subscribe` (#187).
   */
  | { type: "channel:opened"; channelId: string }
  | { type: "channel:closed"; channelId: string }
  /**
   * The payment was made on another model than the one chosen (#183): a
   * channel could not be opened, or the counterparty's channel path is
   * cooling down after a failed open. The `payment` event that follows
   * reports the model that actually paid.
   */
  | {
      type: "fallback";
      resource: string;
      from: SettlementModel;
      to: SettlementModel;
      reason: string;
    }
  | {
      type: "counterparty:quarantined";
      counterparty: string;
      resource: string;
      reason: string;
      entry?: QuarantineEntry;
    };

export type ClientEventHandler = (event: ClientEvent) => void;

/** The events a settler may put on the client's stream. */
export type SettlerEvent = Extract<ClientEvent, { type: "channel:opened" | "channel:closed" }>;

/**
 * The agent-side analog of the server's `FacilitatorClient`. Given a
 * routed offer, the settler runs the protocol-specific flow (sign + post
 * for x402, channel commitment for mpp-channel, etc.) and returns the
 * canonical receipt the service handed back. The client itself does not
 * speak HTTP or sign authorizations; that work lives behind this seam.
 */
export interface ClientSettler {
  settle(input: SettleRequest): Promise<SignedReceipt>;
  /**
   * The Stellar address this settler pays from, when it knows it. The
   * client then requires `receipt.payer` to equal it.
   */
  readonly payer?: string;
  /**
   * Called once by `createClient` with a function that puts a settler's
   * events on the client's `on()` stream (#187). A channel settler wires its
   * channel manager's `channel:opened` and `channel:closed` lifecycle events
   * through it. Settlers that have nothing to report leave it out.
   */
  subscribe?(emit: (event: SettlerEvent) => void): void;
}

/** What `onOrphanedChannel` is told about an open that may have landed (#183). */
export type OrphanedChannel = {
  counterparty: string;
  asset: string;
  channelId?: string;
  txHash?: string;
  error: Error;
};

/**
 * Paying by x402 when a channel cannot be opened (#183). The fallback is
 * taken only for an error with code `channel-open-failed`, which a channel
 * settler throws when the open failed before any voucher was signed. Any
 * later failure may have paid the service already and is never retried on
 * another model.
 */
export type ChannelFallbackOptions = {
  /** The settler that pays when the channel path cannot. */
  x402: ClientSettler;
  /**
   * After a failed open, how long the counterparty's channel path rests
   * before one request may try to open again. Doubles on each further
   * failure, up to `maxCooldownMs`. Defaults to 60 seconds.
   */
  cooldownMs?: number;
  /** The longest cooldown. Defaults to 15 minutes. */
  maxCooldownMs?: number;
  /**
   * How many counterparty and asset pairs the cooldown remembers; the
   * oldest is forgotten first. Defaults to 1000.
   */
  maxTracked?: number;
  /**
   * Called when an open may have landed on chain (`submission:
   * "ambiguous"`), so the funder side can resume or recover the channel.
   * A throwing callback does not fail the payment.
   */
  onOrphanedChannel?: (channel: OrphanedChannel) => void;
};

export type SettleRequest = {
  resource: string;
  offer: PaymentOffer;
  model: SettlementModel;
  /**
   * Set on a retry with a fresh authorization: the terms the earlier
   * attempt signed. A settler must refuse to sign a challenge that asks for
   * anything else (issue #203).
   */
  pinned?: SignedTerms;
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
   * Per-offer sanity checks (#209): price ceilings per asset, payee and asset
   * allowlists, and a zero-amount opt-in. They run in `pay()` before the
   * policy engine and before the settler. The network and structural checks
   * always run. See `offer-checks.ts`.
   */
  offerChecks?: OfferChecks;
  /**
   * Optional quarantine store. When provided, `pay()` checks the
   * counterparty's standing before routing, emits `counterparty:quarantined`,
   * and passes `quarantined: true` to the router (failing closed on lookup
   * error).
   */
  quarantine?: CounterpartyQuarantine;
  /**
   * Optional verifier. When provided, the returned receipt is checked
   * against the verifier's trusted public keys before `pay()` resolves;
   * a tampered or unknown-key receipt produces a `TollwayError` with
   * code `"receipt-verification-failed"`. Recommended in production: the
   * receipt is the service's signature, and skipping verification leaves
   * a tampered receipt undetected on the agent side.
   *
   * Whether or not a verifier is set, the receipt must also describe the
   * paid offer (amount, asset, payee, resource, network, model, settlement
   * kind, payer and `issuedAt`); a mismatch rejects with code
   * `"receipt-offer-mismatch"`. Without a verifier that check runs on an
   * unauthenticated receipt, so it catches mistakes, not forgeries.
   */
  verifier?: ReceiptVerifier;
  /**
   * How far a receipt's `issuedAt` may be from the client clock, in
   * milliseconds, either way. Defaults to five minutes. A receipt replayed
   * from an older payment falls outside it and is rejected.
   */
  receiptMaxSkewMs?: number;
  /** The clock for the `issuedAt` check. Defaults to `Date.now`. */
  clock?: () => number;
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
  /**
   * Issue #203: how many times the client will call the settler per
   * `pay()`. The default is 2 (one retry): the first attempt plus one
   * fresh-authorization retry on an x402 expiry or nonce reuse. Only
   * rejections classified `retryable-with-fresh-auth` or
   * `settlement-in-progress` consume a retry; an `ambiguous` outcome
   * never retries because the payment may have landed.
   */
  retry?: RetryOptions;
  /**
   * Falls back to x402 when a channel open fails (#183). Without it, a
   * failed open is thrown like any other settler error.
   */
  fallback?: ChannelFallbackOptions;
};

export type PayRequest = {
  /** The resource URL to pay for. */
  resource: string;
  /** The offer read from the 402 challenge. */
  offer: PaymentOffer;
  /** Force a settlement model, bypassing the router. */
  model?: SettlementModel;
  /**
   * Names the purchase. Concurrent calls with the same key share one
   * settlement, whatever their resource and offer, and calls with different
   * keys never share one. When omitted, the key is derived from the resource,
   * the routed model, and the offer's amount, asset, payTo and network.
   */
  idempotencyKey?: string;
};

export type PayResult = {
  receipt: SignedReceipt;
  model: SettlementModel;
  /**
   * True when this call shared a concurrent call's settlement and did not
   * pay. The receipt is the one that call was given.
   */
  deduplicated: boolean;
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
  if (
    options.receiptMaxSkewMs !== undefined &&
    !(Number.isFinite(options.receiptMaxSkewMs) && options.receiptMaxSkewMs >= 0)
  ) {
    throw new TypeError(
      `receiptMaxSkewMs must be a non-negative finite number, got ${options.receiptMaxSkewMs}`,
    );
  }
  const fallback = options.fallback;
  const cooldown = fallback ? createChannelCooldown(fallback) : undefined;
  const clientNow = (): number => (options.clock ?? Date.now)();
  if (options.offerChecks) {
    // A typo in a ceiling fails here, at startup, not on the first payment.
    validateOfferChecks(options.offerChecks, options.network);
  }
  // Settlements in progress, by purchase key. In process only: two workers
  // of the same agent do not see each other's entries.
  const inFlight = new Map<string, Promise<Settled>>();
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

  // A settler reports channel lifecycle on the same stream as payments.
  options.settler.subscribe?.(emit);
  fallback?.x402.subscribe?.(emit);

  /**
   * Tells the funder side about an open that may have landed on chain, so a
   * funded channel nobody tracks can be resumed or recovered (#176, #38).
   * An error without a submission state is treated as possibly landed.
   */
  function reportOrphan(error: TollwayError, offer: PaymentOffer): void {
    const submission: ChannelOpenSubmission =
      error instanceof ChannelOpenFailedError ? error.submission : "ambiguous";
    if (submission !== "ambiguous" || !fallback?.onOrphanedChannel) return;
    const details = error instanceof ChannelOpenFailedError ? error : undefined;
    try {
      fallback.onOrphanedChannel({
        counterparty: details?.counterparty ?? offer.payTo,
        asset: details?.asset ?? offer.asset,
        ...(details?.channelId === undefined ? {} : { channelId: details.channelId }),
        ...(details?.txHash === undefined ? {} : { txHash: details.txHash }),
        error,
      });
    } catch {
      // The callback is an alert. A throwing one must not fail a payment
      // that can still be made by x402.
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

  /** Counts one sent payment on the shadow too, so its attempt limits see real traffic. */
  async function shadowAttempt(
    shadow: PolicyEngine,
    intent: PaymentIntent,
    resource: string,
  ): Promise<void> {
    try {
      await shadow.recordAttempt?.(intent);
    } catch (rawError) {
      emit({ type: "policy:shadow-error", resource, error: normalizeError(rawError) });
    }
  }

  /**
   * Calls the settler, then retries the way issue #203 allows: a fresh
   * authorization for a payment the service refused before settling, the
   * identical payment for one it is still settling, and never anything for
   * a payment that may have landed. `maxAttempts` bounds every settler call
   * and resend together.
   */
  async function settleWithRetry(args: {
    retry: { maxAttempts: number; sleep: (ms: number) => Promise<void> };
    request: PayRequest;
    model: SettlementModel;
    settler: ClientSettler;
    freshAttempt: () => Promise<void>;
  }): Promise<SignedReceipt> {
    const { retry, request, model, settler } = args;
    let pinned: SignedTerms | undefined;
    let next = () => settler.settle({ resource: request.resource, offer: request.offer, model });
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await next();
      } catch (rawError) {
        if (!(rawError instanceof SettlementOutcomeError)) throw rawError;
        if (rawError.kind === "ambiguous") {
          throw new AmbiguousSettlementError(rawError.reason, { cause: rawError });
        }
        if (rawError.kind === "fatal") throw rawError;

        const resend = rawError.resend;
        const waitMs = rawError.retryAfterMs;
        if (rawError.kind === "settlement-in-progress") {
          // The payment is in flight. If the client cannot wait for it
          // within its bounds, the outcome is unknown to the caller.
          if (
            resend === undefined ||
            waitMs === undefined ||
            waitMs > MAX_RETRY_AFTER_MS ||
            attempt >= retry.maxAttempts
          ) {
            throw new AmbiguousSettlementError(
              `${rawError.reason}, and the client stopped waiting for it`,
              { cause: rawError },
            );
          }
          emit({
            type: "retry",
            resource: request.resource,
            attempt: attempt + 1,
            reason: rawError.reason,
          });
          await retry.sleep(waitMs);
          next = resend;
          continue;
        }

        // retryable-with-fresh-auth
        if (attempt >= retry.maxAttempts) throw rawError;
        pinned = rawError.signedTerms ?? pinned;
        await args.freshAttempt();
        emit({
          type: "retry",
          resource: request.resource,
          attempt: attempt + 1,
          reason: rawError.reason,
        });
        const terms = pinned;
        next = () =>
          settler.settle({
            resource: request.resource,
            offer: request.offer,
            model,
            ...(terms === undefined ? {} : { pinned: terms }),
          });
      }
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

  /**
   * One payment from policy check to recorded spend. Only this path
   * evaluates the policy, stores the receipt, records the spend and emits
   * `payment`, so calls that share the settlement are not counted twice.
   */
  async function settleOnce(
    request: PayRequest,
    model: SettlementModel,
    settler: ClientSettler,
  ): Promise<Settled> {
    try {
      const intent: PaymentIntent = {
        payee: request.offer.payTo,
        resource: request.resource,
        amount: request.offer.amount,
        asset: request.offer.asset,
        model,
      };

      // `admit` evaluates and, when the policy allows the payment, counts
      // it as an attempt in the same step (issue #197). An engine written
      // before `admit` existed is evaluated instead.
      const admit = async (engine: PolicyEngine, toAdmit: PaymentIntent): Promise<PolicyTrace> =>
        engine.admit ? engine.admit(toAdmit) : engine.evaluate(toAdmit);

      let activeTrace: PolicyTrace | undefined;
      if (options.policy) {
        activeTrace = await admit(options.policy, intent);
        // No handler, no event object: the quiet path stays as cheap as a
        // plain check().
        if (handlers.length > 0) {
          emit({ type: "policy:decision", resource: request.resource, trace: activeTrace });
        }
      }

      if (options.shadow && shadowBaseline && handlers.length > 0) {
        await shadowCompare(options.shadow, shadowBaseline, activeTrace, intent, request.resource);
      }

      const blockIfDenied = (trace: PolicyTrace | undefined): void => {
        if (!trace) return;
        // The same function check() uses, so the trace just emitted and the
        // decision below cannot disagree.
        const decision = decisionFromTrace(trace);
        if (!decision.allowed) {
          emit({
            type: "skip",
            resource: request.resource,
            reason: `${decision.rule}: ${decision.detail}`,
          });
          throw new PolicyBlockedError(decision.rule, decision.detail);
        }
      };
      blockIfDenied(activeTrace);
      if (options.shadow) await shadowAttempt(options.shadow, intent, request.resource);

      /**
       * One payment on one model through one settler. The retry runs
       * inside the shared settlement (issue #210), so calls waiting on this
       * purchase share one retried payment.
       */
      const pay = (settler: ClientSettler, paying: PaymentIntent) =>
        settleWithRetry({
          retry: normaliseRetryOptions(options.retry),
          request,
          model: paying.model,
          settler,
          freshAttempt: async () => {
            // A new authorization is a new payment attempt: the policy is
            // checked again, and a budget that now bites stops the retry.
            if (options.policy) blockIfDenied(await admit(options.policy, paying));
            if (options.shadow) await shadowAttempt(options.shadow, paying, request.resource);
          },
        });

      // What actually paid. A fallback (#183) changes all three.
      let paidIntent = intent;
      let paidBy = settler;
      let settled: SignedReceipt;
      const channelKey = cooldownKey(request.offer);
      try {
        settled = await pay(settler, intent);
        if (model === "mpp-channel") cooldown?.opened(channelKey);
      } catch (rawError) {
        // Anything but an open failure may already have paid the service
        // (a voucher sent, a response lost), so it is never paid again.
        if (model !== "mpp-channel" || !isChannelOpenFailure(rawError)) throw rawError;
        cooldown?.failed(channelKey, clientNow());
        reportOrphan(rawError, request.offer);
        if (!fallback || !request.offer.models.includes("x402")) throw rawError;

        // Nothing was offered to the service on the channel, so paying the
        // same request by x402 cannot pay it twice. x402 is a different
        // model, so the policy is asked again before paying.
        paidIntent = { ...intent, model: "x402" };
        paidBy = fallback.x402;
        emit({
          type: "fallback",
          resource: request.resource,
          from: "mpp-channel",
          to: "x402",
          reason: rawError.message,
        });
        if (options.policy) {
          const fallbackTrace = await admit(options.policy, paidIntent);
          if (handlers.length > 0) {
            emit({ type: "policy:decision", resource: request.resource, trace: fallbackTrace });
          }
          blockIfDenied(fallbackTrace);
        }
        if (options.shadow) await shadowAttempt(options.shadow, paidIntent, request.resource);
        settled = await pay(fallback.x402, paidIntent);
      }
      const paidModel = paidIntent.model;

      // Only the parsed receipt leaves pay(), never the settler's object,
      // so a field the signature does not cover cannot reach the caller.
      const receipt = await checkedReceipt(settled, options.verifier);

      // A valid signature proves only that the service signed something.
      // The receipt must describe this payment before it is stored,
      // recorded on the policy engine or reported as a payment.
      assertReceiptMatchesOffer({
        receipt,
        offer: request.offer,
        model: paidModel,
        network: options.network,
        ...(paidBy.payer === undefined ? {} : { payer: paidBy.payer }),
        now: clientNow(),
        maxSkewMs: options.receiptMaxSkewMs ?? DEFAULT_RECEIPT_MAX_SKEW_MS,
      });

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

      // Budgets advance once, for the model that actually paid.
      if (options.policy) {
        await options.policy.record(paidIntent);
      }
      if (options.shadow) {
        await shadowRecord(options.shadow, paidIntent, request.resource);
      }

      emit({ type: "payment", resource: request.resource, model: paidModel, receipt });
      return storeError ? { receipt, model: paidModel, storeError } : { receipt, model: paidModel };
    } catch (rawError) {
      // A request that was allowed to try the channel after a cooldown frees
      // that slot however it ended, so the next request may try again.
      if (model === "mpp-channel") cooldown?.release(cooldownKey(request.offer));
      const error = normalizeError(rawError);
      emit({ type: "error", resource: request.resource, error });
      throw error;
    }
  }

  return {
    on(handler) {
      handlers.push(handler);
    },
    async pay(request): Promise<PayResult> {
      let model: SettlementModel;
      // The cooldown below sends a channel payment to the fallback's settler.
      let settler = options.settler;
      let emittedQuarantine = false;
      try {
        // Refused before any policy check or signature: paying on the wrong
        // network is never what the agent configured.
        if (request.offer.network !== options.network) {
          throw new OfferNetworkMismatchError(request.offer.network, options.network);
        }
        assertOfferForRequest(request.resource, request.offer);
        // The offer is attacker-controlled input: check it before quarantine,
        // routing, policy or any signature.
        try {
          runOfferChecks(request.offer, request.resource, options.network, options.offerChecks);
        } catch (checkError) {
          if (checkError instanceof OfferRejectedError) {
            emit({
              type: "skip",
              resource: request.resource,
              reason: `${checkError.checkName}: ${checkError.message}`,
            });
          }
          throw checkError;
        }
        let quarantined = false;
        if (options.quarantine) {
          let entry: QuarantineEntry | undefined;
          let lookupFailed = false;
          try {
            entry = await options.quarantine.lookup(request.offer.payTo);
          } catch {
            lookupFailed = true;
          }
          if (entry || lookupFailed) {
            quarantined = true;
            emittedQuarantine = true;
            emit({
              type: "counterparty:quarantined",
              counterparty: request.offer.payTo,
              resource: request.resource,
              reason: entry ? entry.reason : "quarantine lookup failed; failing closed",
              ...(entry ? { entry } : {}),
            });
          }
        }

        const decision = await decideModel(options.router, request, quarantined);
        if (decision.reason === "quarantined" && !emittedQuarantine) {
          emittedQuarantine = true;
          emit({
            type: "counterparty:quarantined",
            counterparty: request.offer.payTo,
            resource: request.resource,
            reason: "router excluded mpp-channel for quarantined counterparty",
          });
        }
        model = decision.model;

        // After a failed open the counterparty's channel path rests (#183):
        // requests go straight to x402 until the cooldown ends, and then one
        // request at a time may try the channel again.
        if (
          model === "mpp-channel" &&
          cooldown &&
          request.offer.models.includes("x402") &&
          cooldown.admit(cooldownKey(request.offer), clientNow()) === "cooling"
        ) {
          model = "x402";
          settler = fallback?.x402 ?? settler;
          emit({
            type: "fallback",
            resource: request.resource,
            from: "mpp-channel",
            to: "x402",
            reason: "the channel path is cooling down after a failed open",
          });
        }
      } catch (rawError) {
        const error = normalizeError(rawError);
        if (
          error instanceof TollwayError &&
          error.code === "counterparty-quarantined" &&
          !emittedQuarantine
        ) {
          emit({
            type: "counterparty:quarantined",
            counterparty: request.offer.payTo,
            resource: request.resource,
            reason: error.message,
          });
        }
        emit({ type: "error", resource: request.resource, error });
        throw error;
      }

      // A call that arrives while the same purchase is being settled waits
      // for that settlement instead of paying again. The map is read and
      // written with no await in between, so two calls cannot both miss it.
      const key = purchaseKey(request, model);
      const pending = inFlight.get(key);
      if (pending) {
        // A shared failure rejects here with the error the settling call
        // already reported, so one failure is one `error` event.
        const shared = await pending;
        emit({
          type: "payment:deduplicated",
          resource: request.resource,
          model: shared.model,
          receipt: shared.receipt,
        });
        return { ...shared, deduplicated: true };
      }

      const attempt = settleOnce(request, model, settler);
      inFlight.set(key, attempt);
      try {
        return { ...(await attempt), deduplicated: false };
      } finally {
        // Completed receipts are not kept: a later call is a new purchase.
        inFlight.delete(key);
      }
    },
  };
}

/** What one settlement produced, before a call marks it as its own or shared. */
type Settled = { receipt: SignedReceipt; model: SettlementModel; storeError?: Error };

/**
 * The key two calls must share to count as the same purchase. A caller's
 * `idempotencyKey` and a derived key carry different prefixes, so a caller's
 * string can never equal a derived key.
 */
function purchaseKey(request: PayRequest, model: SettlementModel): string {
  if (request.idempotencyKey !== undefined) {
    return `key:${request.idempotencyKey}`;
  }
  return `offer:${canonicalJson({
    resource: request.resource,
    model,
    amount: request.offer.amount,
    asset: request.offer.asset,
    payTo: request.offer.payTo,
    network: request.offer.network,
  })}`;
}

/** True for the one error a channel settler throws when an open failed before any voucher. */
function isChannelOpenFailure(error: unknown): error is TollwayError {
  return error instanceof TollwayError && error.code === "channel-open-failed";
}

/** The channel path an offer would use: one counterparty, one asset. */
function cooldownKey(offer: PaymentOffer): string {
  return canonicalJson({ payTo: offer.payTo, asset: offer.asset, network: offer.network });
}

const DEFAULT_CHANNEL_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_CHANNEL_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_MAX_TRACKED_CHANNELS = 1000;

type CooldownEntry = { failures: number; until: number; probing: boolean };

/**
 * Per counterparty and asset: how long the channel path rests after a
 * failed open, and whether one request is already trying it again. Memory
 * is bounded by `maxTracked`; the least recently touched entry goes first.
 */
function createChannelCooldown(options: ChannelFallbackOptions) {
  const initial = options.cooldownMs ?? DEFAULT_CHANNEL_COOLDOWN_MS;
  const max = options.maxCooldownMs ?? DEFAULT_MAX_CHANNEL_COOLDOWN_MS;
  const maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED_CHANNELS;
  for (const [name, value] of [
    ["fallback.cooldownMs", initial],
    ["fallback.maxCooldownMs", max],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number, got ${value}`);
    }
  }
  if (max < initial) {
    throw new TypeError(
      `fallback.maxCooldownMs (${max}) must be at least fallback.cooldownMs (${initial})`,
    );
  }
  if (!Number.isSafeInteger(maxTracked) || maxTracked < 1) {
    throw new TypeError(`fallback.maxTracked must be a positive integer, got ${maxTracked}`);
  }

  const entries = new Map<string, CooldownEntry>();

  function put(key: string, entry: CooldownEntry): void {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxTracked) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    /**
     * `open`: no failure on record. `probe`: the cooldown has ended and this
     * request is the one that tries the channel. `cooling`: pay by x402.
     */
    admit(key: string, now: number): "open" | "probe" | "cooling" {
      const entry = entries.get(key);
      if (!entry) return "open";
      if (entry.probing || now < entry.until) return "cooling";
      put(key, { ...entry, probing: true });
      return "probe";
    },
    opened(key: string): void {
      entries.delete(key);
    },
    failed(key: string, now: number): void {
      const failures = (entries.get(key)?.failures ?? 0) + 1;
      const wait = Math.min(max, initial * 2 ** Math.min(failures - 1, 30));
      put(key, { failures, until: now + wait, probing: false });
    },
    release(key: string): void {
      const entry = entries.get(key);
      if (entry?.probing) put(key, { ...entry, probing: false });
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

/**
 * Returns the receipt as parsed and, when a verifier is set, as verified.
 * Without a verifier the signature is not checked, but the shape still is.
 */
async function checkedReceipt(
  candidate: unknown,
  verifier: ReceiptVerifier | undefined,
): Promise<SignedReceipt> {
  if (verifier) {
    const verification = await verifyReceipt(candidate, verifier);
    if (!verification.valid) {
      throw new ReceiptVerificationError(verification.reason);
    }
    return verification.receipt;
  }
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TollwayError(
      "invalid-receipt",
      `settler returned a malformed receipt: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

async function decideModel(
  router: ModelRouter | undefined,
  request: PayRequest,
  quarantined: boolean,
): Promise<RouteDecision> {
  if (request.model) {
    // An explicit model skips the router, so the quarantine rule the router
    // applies has to be applied here too: a quarantined counterparty never
    // gets a new channel commitment.
    if (request.model === "mpp-channel" && quarantined) {
      throw new TollwayError(
        "counterparty-quarantined",
        `counterparty "${request.offer.payTo}" is quarantined; cannot pay it through mpp-channel`,
      );
    }
    return { model: request.model, reason: "override" };
  }
  if (!router) return { model: "x402", reason: "default" };
  return router.decide({
    counterparty: request.offer.payTo,
    resource: request.resource,
    offer: request.offer,
    ...(quarantined ? { quarantined: true } : {}),
  });
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

export {
  createMppChargeSettler,
  MPP_NETWORK_ID,
  type MppChargeMode,
  type MppChargeSettlerOptions,
  offerAssetContract,
} from "./mpp-charge-settler.js";
export {
  type OfferCheckName,
  type OfferChecks,
  OfferRejectedError,
} from "./offer-checks.js";
export {
  DEFAULT_RECEIPT_MAX_SKEW_MS,
  OfferNetworkMismatchError,
  ReceiptOfferMismatchError,
  resourceIdentity,
} from "./receipt-binding.js";
export {
  createMemoryReceiptStore,
  DEFAULT_RECEIPT_PAGE_SIZE,
  MAX_RECEIPT_PAGE_SIZE,
  type ModelSpendTotal,
  type PayeeSpendTotal,
  type ReceiptFilter,
  type ReceiptHistory,
  type ReceiptQueryPage,
  type ReceiptQueryResult,
  type ReceiptStore,
  type SpendLedger,
  type SpendLedgerQuery,
  type SpendLedgerTotals,
  type SpendTotal,
} from "./receipt-store.js";
export {
  createX402Settler,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
  type X402SettlerOptions,
} from "./x402-settler.js";
