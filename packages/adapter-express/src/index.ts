/**
 * @vegaforge/tollway-adapter-express
 *
 * A thin translation between Express and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Express requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import {
  type AuthorizedPayment,
  type Gate,
  type GateOutcome,
  holdNodeResponse,
  type PaywallOptions,
  type RouteTable,
  renderGateRejection,
  responseTooLarge,
  settlementTiming,
  type TollwayRequest,
  twoPhaseAuthorizer,
} from "@vegaforge/tollway-server";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Where the verified receipt is stashed on res.locals for downstream handlers. */
export const RECEIPT_LOCALS_KEY = "tollwayReceipt";

/** The one body every adapter returns when the gate itself throws (#107). */
const GATE_ERROR_BODY = { error: "payment backend unavailable" } as const;

/**
 * Wraps a gate as Express middleware. On a settled payment it sets the
 * PAYMENT-RESPONSE and TOLLWAY-RECEIPT headers, attaches the receipt to res.locals, and calls
 * next() so the route handler can serve the resource. Otherwise it answers
 * the request itself (402 with the challenge, or the rejection status).
 *
 * With `{ settlement: "after-handler" }` the payment is verified and locked,
 * the route runs with its response held, and the payment settles only if the
 * route answered with a status the gate does not treat as failure (any 5xx
 * by default, including Express's 500 for a thrown error). The held response
 * then goes out with the payment headers; if settlement fails, the client
 * gets the rejection instead. No receipt exists while the route runs, so
 * res.locals carries none in this mode, except for a replay of a payment
 * that already settled.
 *
 * Decision for #107: a gate that throws is answered here as 502 with a fixed
 * body, not forwarded to `next(err)`. Fastify, Hono and Next have no
 * equivalent error channel, and Express's default error page would leak the
 * internal message and break the shared conformance suite. Error reporting is
 * the gate's or an outer middleware's job; this adapter owns the response.
 * The same holds for a gate failure while a two-phase payment settles.
 */
export function expressPaywall(gate: Gate, options?: PaywallOptions): RequestHandler {
  const authorize = twoPhaseAuthorizer(gate, options);
  return (req: Request, res: Response, next: NextFunction): void => {
    const request = toTollwayRequest(req);
    const answered = authorize
      ? authorize(request).then((outcome) => {
          if (outcome.kind === "authorized") return settleAfterHandler(outcome, res, next);
          answer(outcome, res, next);
        })
      : gate(request).then((outcome) => answer(outcome, res, next));
    void answered.catch(() => {
      if (res.headersSent) return;
      res.status(502).json(GATE_ERROR_BODY);
    });
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function expressRouteTable(table: RouteTable, options?: PaywallOptions): RequestHandler {
  // Checked once here, so a bad option fails at startup, not per request.
  settlementTiming(options);
  return (req, res, next) => {
    const match = table.match(req.method, req.originalUrl);
    if (!match) {
      next();
      return;
    }
    expressPaywall(match.gate, options)(req, res, next);
  };
}

function toTollwayRequest(req: Request): TollwayRequest {
  return { method: req.method, url: req.originalUrl, headers: req.headers };
}

function answer(outcome: GateOutcome, res: Response, next: NextFunction): void {
  if (outcome.kind === "settled") {
    res.set(outcome.headers);
    res.locals[RECEIPT_LOCALS_KEY] = outcome.receipt;
    next();
    return;
  }
  if (outcome.kind === "payment-required") {
    res.set(outcome.headers).status(outcome.status).json(outcome.challenge);
    return;
  }
  // The body and headers come from the server's one renderer, so every
  // adapter answers each error code the same way (#161).
  const rejection = renderGateRejection(outcome);
  res.set(rejection.headers).status(rejection.status).json(rejection.body);
}

/**
 * Runs the route with its response held, then settles or abandons. A gate
 * failure here is answered like any gate failure (#107): 502 with the fixed
 * body. Express's chain has moved on, so it is also logged.
 */
async function settleAfterHandler(
  payment: AuthorizedPayment,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const held = holdNodeResponse(res, payment.maxResponseBytes);
  next();
  const result = await held.done;
  try {
    if (result === "closed") {
      await payment.abandon("client-closed");
      return;
    }
    if (result === "too-large") {
      await payment.abandon("response-too-large");
      const rejection = renderGateRejection(responseTooLarge(payment.maxResponseBytes));
      held.replace(rejection.status, rejection.body, rejection.headers);
      return;
    }
    if (payment.isFailure(held.status())) {
      await payment.abandon("handler-failed");
      held.release();
      return;
    }
    const settled = await payment.settle();
    if (settled.kind === "settled") {
      held.release(settled.headers);
      return;
    }
    const rejection = renderGateRejection(settled);
    held.replace(rejection.status, rejection.body, rejection.headers);
  } catch (error) {
    console.error("tollway: two-phase settlement failed", error);
    held.replace(502, GATE_ERROR_BODY);
  }
}
