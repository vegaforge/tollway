/**
 * Typed errors. Anything Tollway throws on purpose is a TollwayError with a
 * stable code, so callers can branch on `code` instead of parsing messages.
 */

export type TollwayErrorCode =
  | "not-implemented"
  | "no-viable-model"
  | "invalid-receipt"
  | "invalid-signing-key"
  | "invalid-amount"
  | "invalid-quote"
  | "invalid-policy"
  | "canonicalization-failed"
  | "invalid-signature-encoding"
  | "invalid-key-set"
  | "key-set-unavailable"
  | "budget-exceeded"
  | "payment-failed"
  | "outcome-unknown"
  | "facilitator-unsupported"
  | "facilitator-unavailable"
  | "facilitator-invalid-response"
  | "policy-blocked"
  | "receipt-verification-failed"
  | "channel-not-found"
  | "channel-not-open"
  | "channel-already-closed"
  | "commitment-exceeds-deposit"
  | "settlement-mismatch"
  | "counterparty-quarantined"
  | "invalid-metrics-query"
  | "invalid-metric"
  | "metrics-query-too-large"
  | "invalid-receipt-query"
  | "invalid-cursor"
  | "corrupt-receipt";

/** An error Tollway throws on purpose. Branch on `code`, which is stable across releases. */
export class TollwayError extends Error {
  readonly code: TollwayErrorCode;

  /**
   * `options.cause` keeps the underlying error, for example the network
   * error behind a failed facilitator call, so callers can classify it.
   */
  constructor(code: TollwayErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TollwayError";
    this.code = code;
  }
}

/**
 * Thrown by stubs for work that is planned but not built. The reference
 * points at the docs/design.md section that describes the missing piece.
 */
export class NotImplementedError extends TollwayError {
  readonly reference: string;

  constructor(feature: string, reference: string) {
    super("not-implemented", `${feature} is not implemented yet. See ${reference}.`);
    this.name = "NotImplementedError";
    this.reference = reference;
  }
}
