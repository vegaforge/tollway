/**
 * @vegaforge/tollway-adapter-express
 *
 * A thin translation between Express and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Express requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import type { Gate, RouteTable } from "@vegaforge/tollway-server";
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
 * Decision for #107: a gate that throws is answered here as 502 with a fixed
 * body, not forwarded to `next(err)`. Fastify, Hono and Next have no
 * equivalent error channel, and Express's default error page would leak the
 * internal message and break the shared conformance suite. Error reporting is
 * the gate's or an outer middleware's job; this adapter owns the response.
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
        if (outcome.headers) res.set(outcome.headers);
        res.status(outcome.status).json({ error: outcome.reason });
      })
      .catch(() => {
        if (res.headersSent) return;
        res.status(502).json(GATE_ERROR_BODY);
      });
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function expressRouteTable(table: RouteTable): RequestHandler {
  return (req, res, next) => {
    const match = table.match(req.method, req.originalUrl);
    if (!match) {
      next();
      return;
    }
    expressPaywall(match.gate)(req, res, next);
  };
}
