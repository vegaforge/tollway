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
  | "invalid-discovery"
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
  | "offer-rejected"
  | "receipt-verification-failed"
  | "receipt-offer-mismatch"
  | "offer-network-mismatch"
  | "channel-not-found"
  | "channel-not-open"
  | "channel-already-closed"
  | "commitment-conflict"
  | "invalid-store-config"
  | "corrupt-channel-record"
  | "commitment-exceeds-deposit"
  | "settlement-mismatch"
  | "counterparty-quarantined"
  | "channel-open-failed"
  | "invalid-metrics-query"
  | "invalid-metric"
  | "metrics-query-too-large"
  | "invalid-receipt-query"
  | "invalid-cursor"
  | "corrupt-receipt"
  | "receipt-conflict";

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

/**
 * How far a failed channel open got (#183). `not-submitted`: nothing reached
 * the chain. `failed`: a transaction was submitted and definitely failed.
 * `ambiguous`: a transaction may have landed, so a funded channel may exist
 * that nobody tracks.
 */
export type ChannelOpenSubmission = "not-submitted" | "failed" | "ambiguous";

/**
 * Thrown by a channel settler when opening a payment channel failed before
 * any voucher was signed or sent (#183, #184). It is the only error the
 * client treats as safe to fall back from: no payment has been offered to
 * the service, so paying the same request by x402 cannot pay it twice.
 */
export class ChannelOpenFailedError extends TollwayError {
  readonly counterparty: string;
  readonly asset: string;
  readonly submission: ChannelOpenSubmission;
  /** The channel contract id, when the open got far enough to have one. */
  readonly channelId?: string;
  /** The open transaction hash, when one was submitted. */
  readonly txHash?: string;

  constructor(details: {
    counterparty: string;
    asset: string;
    submission: ChannelOpenSubmission;
    channelId?: string;
    txHash?: string;
    cause?: unknown;
  }) {
    super(
      "channel-open-failed",
      `could not open a channel to ${details.counterparty} for ${details.asset} (${details.submission})`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ChannelOpenFailedError";
    this.counterparty = details.counterparty;
    this.asset = details.asset;
    this.submission = details.submission;
    if (details.channelId !== undefined) this.channelId = details.channelId;
    if (details.txHash !== undefined) this.txHash = details.txHash;
  }
}
