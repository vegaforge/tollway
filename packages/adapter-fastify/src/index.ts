/**
 * @vegaforge/tollway-adapter-fastify
 *
 * A thin translation between Fastify and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Fastify requests in and gate outcomes out, exactly the same
 * shape as @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-hono, and
 * @vegaforge/tollway-adapter-next. See docs/design.md, "Repository layout".
 */

import type { Gate, GateOutcome, RouteTable } from "@vegaforge/tollway-server";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

type SettledReceipt = Extract<GateOutcome, { kind: "settled" }>["receipt"];

/** Where the verified receipt is stashed on the Fastify request for downstream handlers. */
export const RECEIPT_REQUEST_KEY = "tollwayReceipt";

declare module "fastify" {
  interface FastifyRequest {
    tollwayReceipt?: SettledReceipt;
  }
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
