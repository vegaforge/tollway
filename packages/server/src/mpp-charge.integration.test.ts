import { Mppx as MppxClient, stellar as stellarClient } from "@stellar/mpp/charge/client";
import { Store } from "@stellar/mpp/charge/server";
import { Ed25519Signer } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall } from "./gate.js";
import { createMppChargeHandler } from "./mpp-charge.js";

/**
 * Opt-in integration test: pays a real MPP charge on Stellar testnet, end to
 * end through the gate, so it is skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_MPP_CHARGE_INTEGRATION=true \
 *   TOLLWAY_MPP_PAYER_SECRET=S... \
 *   TOLLWAY_MPP_RECIPIENT=G... \
 *   pnpm --filter @vegaforge/tollway-server test mpp-charge.integration
 *
 * The payer must be a funded testnet account holding the charged token
 * (testnet USDC by default; override with TOLLWAY_MPP_CURRENCY, a SAC
 * address) and enough XLM for fees. TOLLWAY_MPP_AMOUNT sets the price in
 * base units (default 10000, 0.001 USDC). The recipient must hold a
 * trustline for the token.
 */
const RUN = process.env.TOLLWAY_MPP_CHARGE_INTEGRATION === "true";
const PAYER_SECRET = process.env.TOLLWAY_MPP_PAYER_SECRET ?? "";
const RECIPIENT = process.env.TOLLWAY_MPP_RECIPIENT ?? "";
const CURRENCY =
  process.env.TOLLWAY_MPP_CURRENCY ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = process.env.TOLLWAY_MPP_AMOUNT ?? "10000";

describe.skipIf(!RUN)("createMppChargeHandler (testnet integration)", () => {
  it("challenges, then settles a real charge once and returns its tx hash", async () => {
    const gate = createPaywall(
      {
        amount: AMOUNT,
        asset: CURRENCY,
        payTo: RECIPIENT,
        network: "testnet",
        models: ["mpp-charge"],
      },
      {
        signer: await Ed25519Signer.generate("mpp-integration"),
        facilitator: createMockFacilitator(),
        mppChargeHandler: createMppChargeHandler({
          recipient: RECIPIENT,
          currency: CURRENCY,
          network: "testnet",
          secretKey: crypto.randomUUID(),
          store: Store.memory(),
        }),
        cache: createInMemorySettlementCache(),
      },
    );
    const request = { method: "GET", url: "/integration/resource" };

    const challenged = await gate({ ...request, headers: {} });
    expect(challenged.kind).toBe("payment-required");
    if (challenged.kind !== "payment-required") return;

    const agent = MppxClient.create({
      methods: [stellarClient.charge({ secretKey: PAYER_SECRET, decimals: 0 })],
      polyfill: false,
    });
    const authorization = await agent.createCredential(
      new Response(null, { status: challenged.status, headers: challenged.headers }),
    );

    const settled = await gate({ ...request, headers: { authorization } });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") return;
    expect(settled.receipt.receipt.model).toBe("mpp-charge");
    expect(settled.receipt.receipt.settlement).toMatchObject({
      kind: "transaction",
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const retried = await gate({ ...request, headers: { authorization } });
    expect(retried.kind).toBe("settled");
    if (retried.kind !== "settled") return;
    expect(retried.replayed).toBe(true);
    expect(retried.receipt.receipt.id).toBe(settled.receipt.receipt.id);
  }, 90_000);
});
