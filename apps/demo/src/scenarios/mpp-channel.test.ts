/**
 * Tests for the mpp-channel scenario.
 */

import { createMockFacilitator } from "@vegaforge/tollway-server";
import { describe, expect, it } from "vitest";
import { runMppChannelScenario } from "./mpp-channel.js";
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

describe("runMppChannelScenario", () => {
  it("opens a channel, commits 5 times, closes, and reconciles", async () => {
    const result = await runMppChannelScenario(makeMockOptions());

    expect(result.scenario).toBe("mpp-channel");
    expect(result.mock).toBe(true);
    expect(result.commitments).toHaveLength(5);
    expect(result.reconciliationOk).toBe(true);
  });

  it("produces receipts with model mpp-channel and channel-commitment settlement refs", async () => {
    const result = await runMppChannelScenario(makeMockOptions());

    for (const cr of result.commitments) {
      expect(cr.receipt.receipt.model).toBe("mpp-channel");
      expect(cr.receipt.receipt.settlement.kind).toBe("channel-commitment");
    }
  });

  it("produces receipts with strictly increasing sequence numbers starting at 0", async () => {
    const result = await runMppChannelScenario(makeMockOptions());

    const sequences = result.commitments.map((c) => c.sequence);
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
  });

  it("verifies all receipts", async () => {
    const result = await runMppChannelScenario(makeMockOptions());

    for (const cr of result.commitments) {
      expect(cr.receiptValid).toBe(true);
    }
  });

  it("settles exactly once: one open, one close, five signCommitment calls", async () => {
    const result = await runMppChannelScenario(makeMockOptions());

    expect(result.openChannelCalls).toBe(1);
    expect(result.closeChannelCalls).toBe(1);
    expect(result.signCommitmentCalls).toBe(5);
  });

  it("throws when called in live mode (requires #173)", async () => {
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
    await expect(runMppChannelScenario(liveOptions)).rejects.toThrow(/#173/);
  });
});
