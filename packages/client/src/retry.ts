/**
 * Retry orchestration for x402 payments (issue #203). See
 * docs/design.md, "Failure semantics", and the client README.
 *
 * A settler classifies each failure with a {@link SettlementOutcomeError}
 * so the client never parses an English reason:
 *
 * - `retryable-with-fresh-auth`: the service refused the signed payment
 *   before settling it (an expired authorization or a used nonce). Nothing
 *   moved, so signing again is safe. The client re-runs the policy check
 *   first, and pins the next challenge to the terms already signed, so an
 *   offer that changed under the agent stops the retry.
 * - `settlement-in-progress`: the same payment is already being settled.
 *   The client waits `Retry-After` and resends the identical payment
 *   header through `resend`, never a new authorization, so the service's
 *   idempotency answers with the original receipt.
 * - `ambiguous`: the payment may have landed (a 5xx after the signed
 *   request, a dropped connection, a 409 the client cannot read as "in
 *   progress"). It is never retried with a new authorization, because that
 *   can charge twice. The caller reconciles.
 * - `fatal`: the service refused for a reason another attempt will not fix.
 *
 * The orchestration lives in the client rather than in each settler
 * because the policy check and `record` belong to the client.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";

export type SettlementOutcomeKind =
  | "retryable-with-fresh-auth"
  | "settlement-in-progress"
  | "ambiguous"
  | "fatal";

/**
 * The payment terms a settler signed: what the next challenge must still
 * ask for before the client lets it sign again.
 */
export type SignedTerms = { amount: string; asset: string; payTo: string };

type OutcomeOptions =
  | { kind: "retryable-with-fresh-auth"; reason: string; signedTerms: SignedTerms }
  | {
      kind: "settlement-in-progress";
      reason: string;
      /** The service's `Retry-After`, in milliseconds. */
      retryAfterMs: number;
      /** Resends the identical payment header. Never signs anything new. */
      resend: () => Promise<SignedReceipt>;
    }
  | { kind: "ambiguous" | "fatal"; reason: string; cause?: unknown };

/**
 * A settlement failure, classified so the client can decide what to do.
 * `fatal` and the retryable kinds carry code `payment-failed`; `ambiguous`
 * carries `outcome-unknown`.
 */
export class SettlementOutcomeError extends TollwayError {
  readonly kind: SettlementOutcomeKind;
  readonly reason: string;
  readonly retryAfterMs: number | undefined;
  readonly signedTerms: SignedTerms | undefined;
  readonly resend: (() => Promise<SignedReceipt>) | undefined;

  constructor(options: OutcomeOptions) {
    super(
      options.kind === "ambiguous" ? "outcome-unknown" : "payment-failed",
      `settlement ${options.kind}: ${options.reason}`,
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "SettlementOutcomeError";
    this.kind = options.kind;
    this.reason = options.reason;
    this.retryAfterMs =
      options.kind === "settlement-in-progress" ? options.retryAfterMs : undefined;
    this.signedTerms =
      options.kind === "retryable-with-fresh-auth" ? options.signedTerms : undefined;
    this.resend = options.kind === "settlement-in-progress" ? options.resend : undefined;
  }
}

/**
 * Thrown by `pay()` when the payment may have landed and only the outcome
 * is unknown. Do not pay again with a fresh authorization: reconcile first
 * (#211). Code `outcome-unknown`.
 */
export class AmbiguousSettlementError extends TollwayError {
  readonly ambiguous = true as const;
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super("outcome-unknown", `settlement outcome unknown: ${reason}`, options);
    this.name = "AmbiguousSettlementError";
    this.reason = reason;
  }
}

/** Options for retry orchestration on `createClient`. */
export type RetryOptions = {
  /**
   * Most settler calls per `pay()`, counting the first one and every resend.
   * Defaults to 2 (one retry). Clamped to between 1 and 5; set 1 to turn
   * retries off.
   */
  maxAttempts?: number;
  /**
   * Waits out a `Retry-After`. Defaults to `setTimeout`; tests inject one
   * that resolves at once.
   */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CEILING = 5;

/**
 * The longest `Retry-After` the client waits out. A service asking for
 * longer is treated as an unknown outcome: the payment is in flight, and
 * the caller reconciles instead of the client sleeping for minutes.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

export function normaliseRetryOptions(options: RetryOptions | undefined): {
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
} {
  const raw = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Number.isFinite(raw)
    ? Math.min(MAX_ATTEMPTS_CEILING, Math.max(1, Math.floor(raw)))
    : DEFAULT_MAX_ATTEMPTS;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return { maxAttempts, sleep };
}
