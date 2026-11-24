import { describe, expect, it } from "vitest";
import { createMppChargeSettler } from "./mpp-charge-settler.js";

/**
 * Opt-in integration test: pays a real MPP charge route on Stellar testnet
 * with the settler, so it is skipped unless explicitly enabled. Serve a
 * route with the gate's MPP charge handler (packages/server,
 * `createMppChargeHandler`, see mpp-charge.integration.test.ts there), then
 * run:
 *
 *   TOLLWAY_MPP_CLIENT_INTEGRATION=true \
 *   TOLLWAY_MPP_ROUTE_URL=http://127.0.0.1:3000/paid \
 *   TOLLWAY_MPP_PAYER_SECRET=S... \
 *   TOLLWAY_MPP_RECIPIENT=G... \
 *   pnpm --filter @vegaforge/tollway-client test mpp-charge-settler.integration
 *
 * The payer must be a funded testnet account holding the charged token
 * (testnet USDC by default; override with TOLLWAY_MPP_CURRENCY, a SAC
 * address). TOLLWAY_MPP_AMOUNT is the route's price in base units (default
 * 10000). Set TOLLWAY_MPP_MODE=push to submit from the agent; the payer then
 * also needs XLM for the fee.
 */
const RUN = process.env.TOLLWAY_MPP_CLIENT_INTEGRATION === "true";
const ROUTE_URL = process.env.TOLLWAY_MPP_ROUTE_URL ?? "";
const PAYER_SECRET = process.env.TOLLWAY_MPP_PAYER_SECRET ?? "";
const RECIPIENT = process.env.TOLLWAY_MPP_RECIPIENT ?? "";
const CURRENCY =
  process.env.TOLLWAY_MPP_CURRENCY ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = process.env.TOLLWAY_MPP_AMOUNT ?? "10000";
const MODE = process.env.TOLLWAY_MPP_MODE === "push" ? "push" : "pull";

describe.skipIf(!RUN)("createMppChargeSettler (testnet integration)", () => {
  it("pays a live mpp-charge route and returns its receipt", async () => {
    const settler = createMppChargeSettler({
      secretKey: PAYER_SECRET,
      network: "testnet",
      mode: MODE,
    });
    const receipt = await settler.settle({
      resource: ROUTE_URL,
      model: "mpp-charge",
      offer: {
        resource: ROUTE_URL,
        amount: AMOUNT,
        asset: CURRENCY,
        payTo: RECIPIENT,
        network: "testnet",
        models: ["mpp-charge"],
      },
    });
    expect(receipt.receipt.model).toBe("mpp-charge");
    expect(receipt.receipt.settlement).toMatchObject({
      kind: "transaction",
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 120_000);
});
