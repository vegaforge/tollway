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
  responseTooLarge,
  settlementTiming,
  type TollwayRequest,
  twoPhaseAuthorizer,
} from "@vegaforge/tollway-server";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Where the verified receipt is stashed on res.locals for downstream handlers. */
export const RECEIPT_LOCALS_KEY = "tollwayReceipt";

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
 */
export function expressPaywall(gate: Gate, options?: PaywallOptions): RequestHandler {
  const authorize = twoPhaseAuthorizer(gate, options);
  return (req: Request, res: Response, next: NextFunction): void => {
    const request = toTollwayRequest(req);
    if (!authorize) {
      void gate(request)
        .then((outcome) => answer(outcome, res, next))
        .catch(next);
      return;
    }
    void authorize(request)
      .then((outcome) => {
        if (outcome.kind === "authorized") return settleAfterHandler(outcome, res, next);
        answer(outcome, res, next);
      })
      .catch(next);
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
  if (outcome.headers) res.set(outcome.headers);
  res.status(outcome.status).json({ error: outcome.reason });
}

/**
 * Runs the route with its response held, then settles or abandons. Errors
 * after next() cannot go back to Express (the chain has moved on), so they
 * end the held response with a 500 and are logged.
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
      const rejection = responseTooLarge(payment.maxResponseBytes);
      held.replace(rejection.status, { error: rejection.reason });
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
    held.replace(settled.status, { error: settled.reason }, settled.headers);
  } catch (error) {
    console.error("tollway: two-phase settlement failed", error);
    held.replace(500, { error: "settlement-error" });
  }
}
