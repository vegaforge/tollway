import { TollwayError } from "@vegaforge/tollway-core";
import { SERVICE_POLICY_DENIALS } from "./service-policy.js";

/**
 * The machine-readable code every gate rejection carries (#161). A client
 * branches on `code`; the English `reason` is for people and may change.
 * docs/gate-errors.md lists each code with its status, whether the same
 * payment may be sent again, and the headers that come with it.
 */
export type GateErrorCode =
  /** The PAYMENT-SIGNATURE header could not be read as an x402 V2 payment. */
  | "payment-malformed"
  /** The payment was checked and refused, locally or by the facilitator. */
  | "payment-invalid"
  /** The service policy refused this payer (#160). */
  | (typeof SERVICE_POLICY_DENIALS)[keyof typeof SERVICE_POLICY_DENIALS]
  /** This payment already settled for another offer, route or method. */
  | "offer-mismatch"
  /** The same payment is being settled right now by another request. */
  | "settlement-in-progress"
  /** The facilitator refused to settle the payment. */
  | "settlement-failed"
  /** The facilitator could not be reached, or did not answer `/verify` in time. */
  | "facilitator-unavailable"
  /** `/settle` may or may not have landed; the payment is held until it is known. */
  | "settlement-unknown"
  /** The facilitator answered with something the gate cannot trust. */
  | "facilitator-invalid-response"
  /** The route's dynamic price function failed or returned an invalid price. */
  | "price-unavailable"
  /** The gate is missing a handler or is not ready to take payments. */
  | "handler-not-configured"
  /** The router chose a settlement model this gate does not implement. */
  | "model-not-supported";

/** What a client may do after a rejection, and what the response carries. */
export type GateErrorSpec = {
  /** The HTTP status the gate answers with. */
  status: number;
  /**
   * True when sending the identical payment again is safe and may succeed.
   * False means the payment will not be accepted as it is: pay the fresh
   * challenge, fix the request, or stop.
   */
  retrySamePayment: boolean;
  /** Headers this code always carries, lowercase. */
  headers: readonly string[];
};

/**
 * Every gate error code with its status and retry guidance. The adapters,
 * the docs table and the conformance tests all read this one table, so they
 * cannot drift apart.
 */
export const GATE_ERRORS: Readonly<Record<GateErrorCode, GateErrorSpec>> = {
  "payment-malformed": { status: 400, retrySamePayment: false, headers: [] },
  "payment-invalid": { status: 402, retrySamePayment: false, headers: ["payment-required"] },
  [SERVICE_POLICY_DENIALS.notAllowed]: { status: 403, retrySamePayment: false, headers: [] },
  [SERVICE_POLICY_DENIALS.rateLimited]: {
    status: 429,
    retrySamePayment: true,
    headers: ["retry-after"],
  },
  [SERVICE_POLICY_DENIALS.spendExceeded]: {
    status: 429,
    retrySamePayment: true,
    headers: ["retry-after"],
  },
  "offer-mismatch": { status: 409, retrySamePayment: false, headers: [] },
  "settlement-in-progress": { status: 409, retrySamePayment: true, headers: ["retry-after"] },
  "settlement-failed": { status: 502, retrySamePayment: false, headers: [] },
  "facilitator-unavailable": { status: 503, retrySamePayment: true, headers: ["retry-after"] },
  "settlement-unknown": { status: 503, retrySamePayment: true, headers: ["retry-after"] },
  "facilitator-invalid-response": { status: 500, retrySamePayment: false, headers: [] },
  "price-unavailable": { status: 500, retrySamePayment: false, headers: [] },
  "handler-not-configured": { status: 500, retrySamePayment: false, headers: [] },
  "model-not-supported": { status: 501, retrySamePayment: false, headers: [] },
};

/** Every code, in the order the docs list them. */
export const GATE_ERROR_CODES = Object.keys(GATE_ERRORS) as GateErrorCode[];

/**
 * A rejection as the gate returns it. Adapters do not read it field by
 * field: they hand it to {@link renderGateRejection}.
 */
export type GateRejection = {
  kind: "rejected";
  status: number;
  code: GateErrorCode;
  /** A message for people. Never branch on it. */
  reason: string;
  /**
   * The facilitator's or local validator's own reason, such as
   * `invalid_exact_stellar_payload_wrong_amount`, when there is one. It is
   * passed through as received and is never used as `code`.
   */
  upstreamReason?: string;
  /** Headers the response must carry, such as `retry-after` or `payment-required`. */
  headers?: Record<string, string>;
};

/** The JSON body every adapter sends for a rejection. */
export type GateErrorBody = {
  error: {
    code: GateErrorCode;
    message: string;
    /** Present only when the rejection carries an `upstreamReason`. */
    upstreamReason?: string;
  };
};

/** A rejection ready to send: one status, one set of headers, one body. */
export type RenderedGateRejection = {
  status: number;
  headers: Record<string, string>;
  body: GateErrorBody;
};

/**
 * Turns a rejection into the response every adapter sends, so Express,
 * Fastify, Hono and Next answer each code with the same status, headers and
 * body. Adapters only copy the result onto their framework's response.
 */
export function renderGateRejection(rejection: GateRejection): RenderedGateRejection {
  const error: GateErrorBody["error"] = { code: rejection.code, message: rejection.reason };
  if (rejection.upstreamReason !== undefined) error.upstreamReason = rejection.upstreamReason;
  return { status: rejection.status, headers: { ...rejection.headers }, body: { error } };
}

/** Builds a rejection whose status comes from {@link GATE_ERRORS}. */
export function gateRejection(
  code: GateErrorCode,
  reason: string,
  extra: { upstreamReason?: string; headers?: Record<string, string> } = {},
): GateRejection {
  const rejection: GateRejection = {
    kind: "rejected",
    status: GATE_ERRORS[code].status,
    code,
    reason,
  };
  if (extra.upstreamReason !== undefined) rejection.upstreamReason = extra.upstreamReason;
  if (extra.headers !== undefined) rejection.headers = extra.headers;
  return rejection;
}

/** A `Retry-After` value in whole seconds, at least one. */
export function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/**
 * True for an error a facilitator client threw because the facilitator could
 * not be reached or answered with something unusable: `createHttpFacilitator`,
 * the failover client and the MPP charge handler throw these as a
 * `TollwayError` with code `facilitator-unavailable`. Only these become a
 * 503; any other thrown error is a defect and still propagates.
 */
export function isFacilitatorUnavailable(error: unknown): error is TollwayError {
  return error instanceof TollwayError && error.code === "facilitator-unavailable";
}

/** True for the failover client's "the settlement may have landed" error. */
export function isOutcomeUnknown(error: unknown): error is TollwayError {
  return error instanceof TollwayError && error.code === "outcome-unknown";
}
