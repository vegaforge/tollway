/**
 * Retry orchestration for x402 payments (Issue #203). The client calls
 * the settler; when the settler throws a {@link SettlementOutcomeError}
 * with `kind: "retryable-with-fresh-auth"`, the client re-runs the
 * policy check and asks for a fresh signature. A 409
 * "settlement in progress" resends the same header after `Retry-After`,
 * so the gate's idempotency returns the original receipt. Anything
 * ambiguous (a 5xx settle failure, a transport error after the signed
 * request went out) is never retried: the payment may have landed on
 * chain and signing a fresh authorization could charge twice.
 *
 * The retry logic lives next to the client orchestrator rather than
 * inside each settler because `record()` and the policy check belong
 * to the orchestrator, not the protocol-specific settler.
 */

import { TollwayError } from "@vegaforge/tollway-core";

/**
 * The kinds of outcome a settler surfaces so the client can decide what
 * to do. `retryable-with-fresh-auth` is safe to sign again under a new
 * authorization; `settlement-in-progress` must resend the same header
 * after `retryAfterMs`; `ambiguous` must not be retried on another
 * authorization because the payment may have landed; `fatal` is a
 * deliberate rejection the service made and nothing further will help.
 */
export type SettlementOutcomeKind =
  | "retryable-with-fresh-auth"
  | "settlement-in-progress"
  | "ambiguous"
  | "fatal";

/**
 * Typed error a settler throws so the orchestrator knows what to do
 * without parsing English reason strings. Extends `TollwayError` so
 * callers branching on `.code` elsewhere see the same shape; `kind`
 * carries the classification.
 */
export class SettlementOutcomeError extends TollwayError {
  readonly kind: SettlementOutcomeKind;
  readonly reason: string;
  readonly retryAfterMs: number | undefined;

  constructor(options: { kind: SettlementOutcomeKind; reason: string; retryAfterMs?: number }) {
    const code =
      options.kind === "ambiguous"
        ? "outcome-unknown"
        : options.kind === "fatal"
          ? "payment-failed"
          : "payment-failed";
    super(code, `settlement ${options.kind}: ${options.reason}`);
    this.name = "SettlementOutcomeError";
    this.kind = options.kind;
    this.reason = options.reason;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Thrown when a settlement outcome is ambiguous (the signed payment may
 * have landed on chain and only the response was lost). The caller must
 * reconcile - do not retry with a fresh authorization because it can
 * charge twice. See docs/design.md, "Failure semantics".
 */
export class AmbiguousSettlementError extends TollwayError {
  readonly ambiguous = true as const;
  readonly reason: string;
  constructor(reason: string) {
    super("outcome-unknown", `settlement outcome unknown: ${reason}`);
    this.name = "AmbiguousSettlementError";
    this.reason = reason;
  }
}

/** Options for retry orchestration on {@link createClient}. */
export type RetryOptions = {
  /**
   * Maximum settler calls per `pay()`. Defaults to 2 (one retry).
   * Clamped between 1 and 5; a fresh authorization is bounded by the
   * server's challenge timeout anyway, so a hard upper bound protects
   * callers from a misconfigured loop.
   */
  maxAttempts?: number;
  /**
   * Injectable sleep for `settlement-in-progress` retries. Defaults to
   * `setTimeout`. Tests pass `async () => {}` (no actual wait).
   */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CEILING = 5;

/**
 * Normalises the retry config into a strict shape. Caps `maxAttempts`
 * between 1 and `MAX_ATTEMPTS_CEILING`.
 */
export function normaliseRetryOptions(options: RetryOptions | undefined): {
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
} {
  const raw = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.min(MAX_ATTEMPTS_CEILING, Math.max(1, Math.floor(raw)));
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  return { maxAttempts, sleep };
}
