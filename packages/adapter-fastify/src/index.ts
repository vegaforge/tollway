/**
 * @vegaforge/tollway-adapter-fastify
 *
 * A thin translation between Fastify and the framework-agnostic gate in
 * @vegaforge/tollway-server. All the payment logic lives in the gate; this adapter
 * only maps Fastify requests in and gate outcomes out, exactly the same
 * shape as @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-hono, and
 * @vegaforge/tollway-adapter-next. See docs/design.md, "Repository layout".
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
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

type SettledReceipt = Extract<GateOutcome, { kind: "settled" }>["receipt"];

/** Where the verified receipt is stashed on the Fastify request for downstream handlers. */
export const RECEIPT_REQUEST_KEY = "tollwayReceipt";

/** The one body every adapter returns when the gate itself throws (#107). */
const GATE_ERROR_BODY = { error: "payment backend unavailable" } as const;

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
 *
 * With `{ settlement: "after-handler" }` the payment is verified and locked,
 * the route runs with its response held, and the payment settles only if the
 * route answered with a status the gate does not treat as failure (any 5xx
 * by default, including Fastify's 500 for a thrown error). The held response
 * then goes out with the payment headers; if settlement fails, the client
 * gets the rejection instead. No receipt exists while the route runs, so
 * `request.tollwayReceipt` is only set for a replay in this mode.
 */
export function fastifyPaywall(gate: Gate, options?: PaywallOptions): preHandlerHookHandler {
  const authorize = twoPhaseAuthorizer(gate, options);
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await runGate(gate, authorize !== undefined, request, reply);
    } catch {
      if (!reply.sent) await reply.status(502).send(GATE_ERROR_BODY);
    }
  };
}

/** Routes paid requests through a compiled table; unmatched requests continue unchanged. */
export function fastifyRouteTable(
  table: RouteTable,
  options?: PaywallOptions,
): preHandlerHookHandler {
  const afterHandler = settlementTiming(options) === "after-handler";
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const match = table.match(request.method, request.url);
    if (!match) return;
    try {
      await runGate(match.gate, afterHandler, request, reply);
    } catch {
      if (!reply.sent) await reply.status(502).send(GATE_ERROR_BODY);
    }
  };
}

async function runGate(
  gate: Gate,
  afterHandler: boolean,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tollwayRequest: TollwayRequest = {
    method: request.method,
    url: request.url,
    headers: request.headers,
  };
  const authorize = afterHandler
    ? twoPhaseAuthorizer(gate, { settlement: "after-handler" })
    : undefined;
  const outcome = authorize ? await authorize(tollwayRequest) : await gate(tollwayRequest);

  if (outcome.kind === "authorized") {
    // Not awaited: the route runs once this hook returns, and the hold
    // finishes the response when the route has written it.
    void settleAfterHandler(outcome, request, reply);
    return;
  }

  await answer(outcome, request, reply);
}

async function answer(
  outcome: GateOutcome,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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

/**
 * Holds the raw response while the route runs, then settles or abandons.
 * Fastify writes through `reply.raw`, so holding it holds serialized bodies
 * and streams alike. A gate failure here has no hook left to throw to, so it
 * is answered like any gate failure (#107), 502 with the fixed body, and goes
 * to the request logger.
 */
async function settleAfterHandler(
  payment: AuthorizedPayment,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const held = holdNodeResponse(reply.raw, payment.maxResponseBytes);
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
    request.log.error({ err: error }, "tollway: two-phase settlement failed");
    held.replace(502, GATE_ERROR_BODY);
  }
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}
