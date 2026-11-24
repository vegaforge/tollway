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
  type Gate,
  type GateOutcome,
  type RequestBodySource,
  type RouteTable,
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
  return async function preParsing(request, _reply, payload) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of payload as AsyncIterable<Buffer>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw Object.assign(new BodyTooLargeError(maxBytes), { statusCode: 413 });
      }
      chunks.push(chunk);
    }
    const bytes = concatChunks(chunks, total);
    request.tollwayRawBody = bytes;
    const replay = Readable.from([Buffer.from(bytes)]);
    return Object.assign(replay, { receivedEncodedLength: total });
  };
}

/** True when the request carries a body at all, by its headers. */
function hasBody(request: FastifyRequest): boolean {
  return (
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0
  );
}

function fastifyBody(request: FastifyRequest): RequestBodySource {
  return {
    async read(maxBytes) {
      const bytes = request.tollwayRawBody;
      if (bytes === undefined) {
        // Fastify does not run preParsing for a request without a body.
        if (!hasBody(request)) return new Uint8Array(0);
        throw new Error(
          "this route binds the request body; register fastifyRawBody() as a preParsing hook so the raw bytes are kept",
        );
      }
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
    await runGate(gate, request, reply);
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function fastifyRouteTable(table: RouteTable): preHandlerHookHandler {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const match = table.match(request.method, request.url);
    if (!match) return;
    await runGate(match.gate, request, reply);
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

  applyHeaders(reply, outcome.headers ?? {});
  await reply.status(outcome.status).send({ error: outcome.reason });
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}
