/**
 * @vegaforge/tollway-adapter-express
 *
 * A thin translation between Express and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Express requests in and gate outcomes out. See docs/design.md,
 * "Repository layout".
 */

import {
  BodyTooLargeError,
  concatChunks,
  type Gate,
  type RequestBodySource,
  type RouteTable,
} from "@vegaforge/tollway-server";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Where the verified receipt is stashed on res.locals for downstream handlers. */
export const RECEIPT_LOCALS_KEY = "tollwayReceipt";

/**
 * Wraps a gate as Express middleware. On a settled payment it sets the
 * PAYMENT-RESPONSE and TOLLWAY-RECEIPT headers, attaches the receipt to res.locals, and calls
 * next() so the route handler can serve the resource. Otherwise it answers
 * the request itself (402 with the challenge, or the rejection status).
 */
export function expressPaywall(gate: Gate): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void gate({
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: expressBody(req),
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
      .catch(next);
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

/** The raw bytes a body parser kept, when one ran before the paywall. */
type WithRawBody = Request & { rawBody?: unknown; _body?: boolean };

/**
 * The request body for a route with `bindBody` (#164), read only when the
 * gate asks.
 *
 * - If a parser ran first and kept the raw bytes (`express.raw()`, or
 *   `express.json({ verify })` storing `req.rawBody`), those are used.
 * - If no parser ran, the stream is read here, stopping at the limit. The
 *   bytes are then left on `req.rawBody` and, when nothing set `req.body`,
 *   on `req.body` as a Buffer, so the handler still gets the whole body.
 * - If a parser consumed the stream without keeping the raw bytes, there is
 *   nothing left to bind, and the request fails rather than binding nothing.
 */
function expressBody(req: Request): RequestBodySource {
  const request = req as WithRawBody;
  return {
    async read(maxBytes) {
      const kept = request.rawBody ?? (Buffer.isBuffer(request.body) ? request.body : undefined);
      if (kept instanceof Uint8Array) {
        if (kept.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
        return kept;
      }
      if (request._body === true || request.readableEnded) {
        throw new Error(
          "the request body was parsed before the paywall without keeping its raw bytes; use express.raw() or store them with express.json({ verify }) as req.rawBody",
        );
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
        chunks.push(chunk);
      }
      const bytes = Buffer.from(concatChunks(chunks, total));
      request.rawBody = bytes;
      if (request.body === undefined) request.body = bytes;
      // body-parser skips a request it sees as already parsed.
      request._body = true;
      return bytes;
    },
  };
}
