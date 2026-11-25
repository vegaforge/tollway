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
  BodyTooLargeError,
  concatChunks,
  type Gate,
  type GateOutcome,
  holdNodeResponse,
  type PaywallOptions,
  type RequestBodySource,
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
  return { method: req.method, url: req.originalUrl, headers: req.headers, body: expressBody(req) };
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
  res.set(rejection.headers);
  // A 413 leaves the rest of the upload unread, so the connection
  // cannot be reused: close it once the answer is sent.
  if (rejection.status === 413) res.set("Connection", "close");
  res.status(rejection.status).json(rejection.body);
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
