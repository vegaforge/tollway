/**
 * @tollway/adapter-express
 *
 * A thin translation between Express and the framework-agnostic gate in
 * @tollway/server. All the payment logic lives in the gate; this adapter
 * only maps Express requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import type { Gate } from "@tollway/server";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Where the verified receipt is stashed on res.locals for downstream handlers. */
export const RECEIPT_LOCALS_KEY = "tollwayReceipt";

/**
 * Wraps a gate as Express middleware. On a settled payment it sets the
 * PAYMENT-RESPONSE header, attaches the receipt to res.locals, and calls
 * next() so the route handler can serve the resource. Otherwise it answers
 * the request itself (402 with the challenge, or the rejection status).
 */
export function expressPaywall(gate: Gate): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void gate({
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
    })
      .then((outcome) => {
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
        res.status(outcome.status).json({ error: outcome.reason });
      })
      .catch(next);
  };
}
