/**
 * @tollway/adapter-hono
 *
 * Hono adapter for the Tollway payment gate. The shape mirrors
 * @tollway/adapter-express, the worked reference: a thin map from Hono
 * requests into the gate and gate outcomes back out. See docs/design.md,
 * "Repository layout".
 *
 * TODO(good first issue): implement honoPaywall as middleware, following
 * packages/adapter-express/src/index.ts. On a settled outcome set the
 * PAYMENT-RESPONSE header and call next(); on payment-required answer 402
 * with the challenge; on rejected answer the rejection status. Expose the
 * verified receipt via the Hono context, and cover the flow with a test
 * using app.request().
 */

import { NotImplementedError } from "@tollway/core";
import type { Gate } from "@tollway/server";
import type { MiddlewareHandler } from "hono";

export function honoPaywall(_gate: Gate): MiddlewareHandler {
  throw new NotImplementedError(
    "the Hono adapter",
    'docs/design.md, "Repository layout"; see @tollway/adapter-express for the reference',
  );
}
