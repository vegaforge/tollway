/**
 * @vegaforge/tollway-adapter-fastify
 *
 * A thin translation between Fastify and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Fastify requests in and gate outcomes out, exactly the same
 * shape as @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-hono, and
 * @vegaforge/tollway-adapter-next. See docs/design.md, "Repository layout".
 */

import { Readable } from "node:stream";
import {
  BodyTooLargeError,
  concatChunks,
  GATE_ERRORS,
  type Gate,
  type GateOutcome,
  type RequestBodySource,
  type RouteTable,
  renderGateRejection,
} from "@vegaforge/tollway-server";
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  preParsingHookHandler,
} from "fastify";

type SettledReceipt = Extract<GateOutcome, { kind: "settled" }>["receipt"];

/** Where the verified receipt is stashed on the Fastify request for downstream handlers. */
export const RECEIPT_REQUEST_KEY = "tollwayReceipt";

/** The one body every adapter returns when the gate itself throws (#107). */
const GATE_ERROR_BODY = { error: "payment backend unavailable" } as const;

declare module "fastify" {
  interface FastifyRequest {
    tollwayReceipt?: SettledReceipt;
    /** The raw body bytes kept by {@link fastifyRawBody}, for body binding. */
    tollwayRawBody?: Uint8Array;
  }
}

/** Default for {@link fastifyRawBody}'s `maxBytes`: Fastify's own default body limit. */
const DEFAULT_RAW_BODY_LIMIT = 1_048_576;

/**
 * A `preParsing` hook that keeps the raw request bytes for routes whose gate
 * binds the body (#164). Fastify parses the body before `preHandler`, so
 * without it the exact bytes are gone by the time the paywall runs. It reads
 * the payload up to `maxBytes`, answering 413 as soon as that is passed, and
 * hands Fastify's parser an identical stream, so the route handler sees the
 * same parsed body as without it. Set `maxBytes` to at least the largest
 * `bindBody.maxBytes` of the routes it covers.
 */
export function fastifyRawBody(options: { maxBytes?: number } = {}): preParsingHookHandler {
  const maxBytes = options.maxBytes ?? DEFAULT_RAW_BODY_LIMIT;
  if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) {
    throw new TypeError(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  return async function preParsing(request, reply, payload) {
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(payload, maxBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Answer here, in the same `body-too-large` shape the gate uses
        // (#161), rather than through Fastify's own error handler. Sending
        // from the hook stops the chain, so no parser or handler runs. The
        // rest of the upload stays unread, so the connection cannot be
        // reused: close it once the 413 is sent.
        const rejection = renderGateRejection({
          kind: "rejected",
          status: GATE_ERRORS["body-too-large"].status,
          code: "body-too-large",
          reason: error.message,
        });
        await reply
          .headers({ ...rejection.headers, Connection: "close" })
          .status(rejection.status)
          .send(rejection.body);
        return payload;
      }
      throw error;
    }
    request.tollwayRawBody = bytes;
    const replay = Readable.from([Buffer.from(bytes)]);
    return Object.assign(replay, { receivedEncodedLength: bytes.byteLength });
  };
}

/**
 * Reads a payload stream up to `maxBytes`. On overflow it stops listening and
 * pauses the stream rather than destroying it, so the socket is still there
 * to carry the 413.
 */
function readCapped(payload: NodeJS.ReadableStream, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const detach = () => {
      payload.removeListener("data", onData);
      payload.removeListener("end", onEnd);
      payload.removeListener("error", onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        detach();
        payload.pause();
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
    payload.on("data", onData);
    payload.on("end", onEnd);
    payload.on("error", onError);
  });
}

/** True when the request carries a body at all, by its headers. */
function hasBody(request: FastifyRequest): boolean {
  return (
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0
  );
}

/**
 * The body source for the gate. When the request carried a body but
 * `fastifyRawBody` did not keep its bytes (the hook is not registered), it
 * returns undefined: a route with `bindBody` then fails closed with
 * `body-not-provided` (500), and a route without it never reads the body.
 * Register `fastifyRawBody()` as a preParsing hook for body-bound routes.
 */
function fastifyBody(request: FastifyRequest): RequestBodySource | undefined {
  const bytes = request.tollwayRawBody;
  if (bytes === undefined) {
    // Fastify does not run preParsing for a request without a body.
    return hasBody(request) ? undefined : { read: async () => new Uint8Array(0) };
  }
  return {
    async read(maxBytes) {
      if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
      return bytes;
    },
  };
}

/**
 * Wraps a gate as a Fastify `preHandler` hook. On a settled payment it
 * sets the PAYMENT-RESPONSE and TOLLWAY-RECEIPT headers, attaches the receipt to
 * `request.tollwayReceipt`, and returns so the downstream route handler
 * runs. Otherwise it answers the request itself (402 with the challenge,
 * or the rejection status).
 */
export function fastifyPaywall(gate: Gate): preHandlerHookHandler {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await runGate(gate, request, reply);
    } catch {
      if (!reply.sent) await reply.status(502).send(GATE_ERROR_BODY);
    }
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function fastifyRouteTable(table: RouteTable): preHandlerHookHandler {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const match = table.match(request.method, request.url);
    if (!match) return;
    try {
      await runGate(match.gate, request, reply);
    } catch {
      if (!reply.sent) await reply.status(502).send(GATE_ERROR_BODY);
    }
  };
}

async function runGate(gate: Gate, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const outcome = await gate({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: fastifyBody(request),
  });

  if (outcome.kind === "settled") {
    applyHeaders(reply, outcome.headers);
    request.tollwayReceipt = outcome.receipt;
    return;
  }

  if (outcome.kind === "payment-required") {
    applyHeaders(reply, outcome.headers);
    await reply.status(outcome.status).send(outcome.challenge);
    return;
  }

  // The body and headers come from the server's one renderer, so every
  // adapter answers each error code the same way (#161).
  const rejection = renderGateRejection(outcome);
  applyHeaders(reply, rejection.headers);
  await reply.status(rejection.status).send(rejection.body);
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}
