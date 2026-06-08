/**
 * @tollway/adapter-fastify
 *
 * Fastify adapter for the Tollway payment gate. The shape mirrors
 * @tollway/adapter-express, the worked reference: a thin map from Fastify
 * requests into the gate and gate outcomes back out. See docs/design.md,
 * "Repository layout".
 *
 * TODO(good first issue): implement fastifyPaywall as a preHandler hook,
 * following packages/adapter-express/src/index.ts. On a settled outcome set
 * the PAYMENT-RESPONSE header and let the handler run; on payment-required
 * answer 402 with the challenge; on rejected answer the rejection status.
 * Expose the verified receipt to downstream handlers, and cover the flow
 * with a test using Fastify's inject().
 */

import { NotImplementedError } from "@tollway/core";
import type { Gate } from "@tollway/server";
import type { preHandlerHookHandler } from "fastify";

export function fastifyPaywall(_gate: Gate): preHandlerHookHandler {
  throw new NotImplementedError(
    "the Fastify adapter",
    'docs/design.md, "Repository layout"; see @tollway/adapter-express for the reference',
  );
}
