/**
 * Typed errors. Anything Tollway throws on purpose is a TollwayError with a
 * stable code, so callers can branch on `code` instead of parsing messages.
 */

export type TollwayErrorCode =
  | "not-implemented"
  | "no-viable-model"
  | "invalid-receipt"
  | "invalid-amount"
  | "canonicalization-failed"
  | "budget-exceeded"
  | "payment-failed"
  | "channel-not-found"
  | "channel-not-open"
  | "commitment-exceeds-deposit";

export class TollwayError extends Error {
  readonly code: TollwayErrorCode;

  constructor(code: TollwayErrorCode, message: string) {
    super(message);
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
