import { Ed25519Signer } from "@vegaforge/tollway-core";
import { createHttpFacilitator, createPaywall } from "@vegaforge/tollway-server";

/**
 * The smallest useful Worker: one paid route through the HTTP facilitator.
 * Its bundle size is what tests/edge/bundle-budget.json guards.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const gate = createPaywall(
      { amount: "10000", asset: "CUSDC", payTo: "GSERVICE", network: "testnet" },
      {
        signer: await Ed25519Signer.generate("worker"),
        facilitator: createHttpFacilitator("https://facilitator.example"),
      },
    );
    const outcome = await gate({
      method: request.method,
      url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
    });
    return new Response(null, { status: outcome.status, headers: outcome.headers });
  },
};
