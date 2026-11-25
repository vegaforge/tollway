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
  renderGateRejection,
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
        // The body and headers come from the server's one renderer, so every
        // adapter answers each error code the same way (#161).
        const rejection = renderGateRejection(outcome);
        res.set(rejection.headers);
        // A 413 leaves the rest of the upload unread, so the connection
        // cannot be reused: close it once the answer is sent.
        if (rejection.status === 413) res.set("Connection", "close");
        res.status(rejection.status).json(rejection.body);
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

/**
 * Reads a Node request up to `maxBytes`. On overflow it stops listening and
 * pauses the stream, but does not destroy it: destroying the request would
 * destroy the socket before the 413 is written. The 413 is then sent with
 * `Connection: close`, which closes the socket and drops the rest of the
 * upload.
 */
function readNodeBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const detach = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        detach();
        request.pause();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      detach();
      resolve(concatChunks(chunks, total));
    };
    const onError = (error: Error) => {
      detach();
      reject(error);
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
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
      const bytes = Buffer.from(await readNodeBody(request, maxBytes));
      request.rawBody = bytes;
      if (request.body === undefined) request.body = bytes;
      // body-parser skips a request it sees as already parsed.
      request._body = true;
      return bytes;
    },
  };
}
