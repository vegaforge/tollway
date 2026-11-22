/**
 * Tests for the mpp-charge scenario.
 */

import { createMockFacilitator } from "@vegaforge/tollway-server";
import { describe, expect, it } from "vitest";
import { runMppChargeScenario } from "./mpp-charge.js";
import type { ScenarioOptions } from "./types.js";

function makeMockOptions(): ScenarioOptions {
  return {
    setup: {
      mock: true,
      facilitator: createMockFacilitator(),
      paywall: {
        asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        network: "testnet",
      },
      payer: async (requirements) => ({
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "mock-signed-auth-entry" },
      }),
    },
  };
}

describe("runMppChargeScenario", () => {
  it("runs the mpp-charge happy path and verifies the receipt", async () => {
    const result = await runMppChargeScenario(makeMockOptions());

    expect(result.scenario).toBe("mpp-charge");
    expect(result.mock).toBe(true);
    expect(result.amount).toBe("10000");
    expect(result.receipt.receipt.model).toBe("mpp-charge");
    expect(result.receipt.receipt.settlement.kind).toBe("transaction");
    expect(result.receiptValid).toBe(true);
  });

  it("throws when called in live mode (requires #100)", async () => {
    const liveOptions: ScenarioOptions = {
      setup: {
        mock: false,
        facilitator: createMockFacilitator(),
        paywall: {
          asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          network: "testnet",
        },
        payer: async (requirements) => ({
          x402Version: 2,
          accepted: requirements,
          payload: { transaction: "mock-signed-auth-entry" },
        }),
      },
    };
    await expect(runMppChargeScenario(liveOptions)).rejects.toThrow(/#100/);
  });
});
