import type { PaymentOffer, X402Payment } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createHttpFacilitator } from "./facilitator.js";

/**
 * Opt-in integration tests: these reach a live testnet facilitator over the
 * network, so they are skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_FACILITATOR_INTEGRATION=true pnpm --filter @tollway/server test
 *
 * Override the facilitator with TOLLWAY_FACILITATOR_URL. The default is the
 * OpenZeppelin Stellar facilitator from docs/design.md, live on testnet.
 */
const RUN = process.env.TOLLWAY_FACILITATOR_INTEGRATION === "true";
const FACILITATOR_URL =
  process.env.TOLLWAY_FACILITATOR_URL ?? "https://channels.openzeppelin.com/x402";

describe.skipIf(!RUN)("createHttpFacilitator (integration)", () => {
  const facilitator = createHttpFacilitator(FACILITATOR_URL);

  it("reads /supported from a live testnet facilitator", async () => {
    const supported = await facilitator.supported();
    expect(Array.isArray(supported.models)).toBe(true);
    expect(supported.models).toContain("x402");
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
    const payment: X402Payment = { model: "x402", paymentSignature: transaction as string };

    const result = await facilitator.verify({ payment, offer });
    // The facilitator may accept or reject; either way it returns a structured result.
    expect(result).toHaveProperty("valid");
  });
});
