/**
 * @tollway/adapter-next
 *
 * Next.js App Router adapter for the Tollway payment gate. App Router route
 * handlers are plain Web fetch handlers, so this adapter works with the
 * standard Request and Response. The shape mirrors @tollway/adapter-express,
 * the worked reference. See docs/design.md, "Repository layout".
 *
 * TODO(good first issue): implement withPaywall to wrap a route handler,
 * following packages/adapter-express/src/index.ts. Run the wrapped handler
 * only on a settled outcome, handing it the receipt and adding the
 * PAYMENT-RESPONSE header to its response; answer payment-required with the
 * challenge and rejected with the rejection status. Cover the flow with a
 * test that calls the handler with a Web Request, no server needed.
 */

import { NotImplementedError, type SignedReceipt } from "@tollway/core";
import type { Gate } from "@tollway/server";

/** Extra argument a paid handler receives: the verified receipt. */
export type PaidContext = { receipt: SignedReceipt };

/** A route handler that only runs after payment has settled. */
export type PaidHandler = (request: Request, context: PaidContext) => Response | Promise<Response>;

export function withPaywall(
  _gate: Gate,
  _handler: PaidHandler,
): (request: Request) => Promise<Response> {
  throw new NotImplementedError(
    "the Next.js adapter",
    'docs/design.md, "Repository layout"; see @tollway/adapter-express for the reference',
  );
}
