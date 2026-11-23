import type { PaymentOffer, X402Payment } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createHttpFacilitator } from "./facilitator.js";

/**
 * Opt-in integration tests: these reach a live testnet facilitator over the
 * network, so they are skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_FACILITATOR_INTEGRATION=true pnpm --filter @vegaforge/tollway-server test
 *
 * OpenZeppelin Channels requires an API key on testnet and mainnet. Set
 * OZ_API_KEY (generate one at https://channels.openzeppelin.com/testnet/gen);
 * it is sent as a Bearer token on every call.
 *
 * Override the facilitator with TOLLWAY_FACILITATOR_URL. The default is the
 * OpenZeppelin Channels testnet facilitator from docs/design.md.
 */
const RUN = process.env.TOLLWAY_FACILITATOR_INTEGRATION === "true";
const FACILITATOR_URL =
  process.env.TOLLWAY_FACILITATOR_URL ?? "https://channels.openzeppelin.com/x402/testnet";
const API_KEY = process.env.OZ_API_KEY;

describe.skipIf(!RUN)("createHttpFacilitator (integration)", () => {
  const auth = { Authorization: `Bearer ${API_KEY}` };
  const facilitator = createHttpFacilitator(FACILITATOR_URL, {
    createAuthHeaders: API_KEY
      ? async () => ({ verify: auth, settle: auth, supported: auth })
      : undefined,
  });

  it("reads /supported from a live testnet facilitator", async () => {
    const supported = await facilitator.supported();
    // Issue #155: /supported now returns the full capability set from
    // @x402/core (kinds, extensions, signers) rather than the lossy
    // { models, assets } shape. A live Stellar testnet facilitator
    // must advertise at least one v2 `exact` kind for stellar:testnet
    // or the wildcard stellar:*.
    expect(Array.isArray(supported.kinds)).toBe(true);
    expect(
      supported.kinds.some(
        (kind) =>
          kind.x402Version === 2 &&
          kind.scheme === "exact" &&
          (kind.network === "stellar:testnet" || kind.network === "stellar:*"),
      ),
    ).toBe(true);
  });

  // Verifying needs a real signed testnet transaction. Supply one (and the
  // matching offer fields) to exercise /verify against the live facilitator.
  const transaction = process.env.TOLLWAY_TEST_PAYMENT_TX;
  it.skipIf(!transaction)("verifies a real signed payment against /verify", async () => {
    const offer: PaymentOffer = {
      resource: process.env.TOLLWAY_TEST_RESOURCE ?? "https://example.com/resource",
      amount: process.env.TOLLWAY_TEST_AMOUNT ?? "10000",
      asset:
        process.env.TOLLWAY_TEST_ASSET ??
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: process.env.TOLLWAY_TEST_PAY_TO ?? "",
      network: "testnet",
      models: ["x402"],
    };
    const payment: X402Payment = {
      model: "x402",
      payload: {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "stellar:testnet",
          asset: offer.asset,
          amount: offer.amount,
          payTo: offer.payTo,
          maxTimeoutSeconds: 60,
          extra: {},
        },
        payload: { transaction: transaction as string },
      },
    };

    const result = await facilitator.verify({ payment, offer });
    // The facilitator may accept or reject; either way it returns a structured result.
    expect(result).toHaveProperty("valid");
  });
});
