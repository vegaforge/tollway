/**
 * Tests for the high-frequency channel scenario.
 *
 * Runs with N=500 as the issue requires, asserting call counts, contiguous
 * sequences, clean reconciliation, and the settled total.
 */

import {
  createChannelManager,
  createMemoryCommitmentStore,
  createMockMppChannelAdapter,
  SettlementMismatchError,
} from "@vegaforge/tollway-channels";
import { createMockFacilitator } from "@vegaforge/tollway-server";
import { describe, expect, it } from "vitest";
import { runHighFrequencyScenario } from "./high-frequency.js";
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

describe("runHighFrequencyScenario", () => {
  it("runs N=500 commitments with exactly one open and one close", async () => {
    const result = await runHighFrequencyScenario(makeMockOptions(), { n: 500 });

    expect(result.scenario).toBe("high-frequency");
    expect(result.mock).toBe(true);
    expect(result.n).toBe(500);
    expect(result.openChannelCalls).toBe(1);
    expect(result.closeChannelCalls).toBe(1);
  }, 30_000);

  it("produces a contiguous commitment stream from sequence 0", async () => {
    const { adapter } = createMockMppChannelAdapter();
    const store = createMemoryCommitmentStore();
    const manager = createChannelManager({ adapter, store });

    const channel = await manager.open({
      counterparty: "GRECIPIENT",
      asset: "USDC",
      deposit: "20000000",
      network: "testnet",
    });

    for (let i = 0; i < 50; i++) {
      await manager.commit(channel.id, "10000");
    }

    const commitments = await manager.list(channel.id);
    const sequences = commitments.map((c) => c.sequence);
    expect(sequences).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("reconciliation returns ok for N=500", async () => {
    const result = await runHighFrequencyScenario(makeMockOptions(), { n: 500 });

    expect(result.reconciliationOk).toBe(true);
  }, 30_000);

  it("settled total equals N * price per request as bigint", async () => {
    const n = 10;
    const result = await runHighFrequencyScenario(makeMockOptions(), { n });

    expect(BigInt(result.settledTotal)).toBe(BigInt(n) * BigInt("10000"));
  });

  it("reports throughput and latency values", async () => {
    const result = await runHighFrequencyScenario(makeMockOptions(), { n: 20 });

    expect(result.throughputCommitmentsPerSecond).toBeGreaterThan(0);
    expect(result.p50LatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.p95LatencyMs).toBeGreaterThanOrEqual(result.p50LatencyMs);
  });

  it("under-settlement by one base unit causes SettlementMismatchError", async () => {
    // Use the channel manager directly with an adapter that under-settles.
    const { adapter } = createMockMppChannelAdapter();
    const badAdapter = {
      ...adapter,
      closeChannel: async (input: Parameters<typeof adapter.closeChannel>[0]) => {
        const result = await adapter.closeChannel(input);
        // Under-settle by one base unit.
        return {
          ...result,
          settledAmount: (BigInt(result.settledAmount) - 1n).toString(),
        };
      },
    };
    const store = createMemoryCommitmentStore();
    const manager = createChannelManager({ adapter: badAdapter, store });

    const channel = await manager.open({
      counterparty: "G",
      asset: "USDC",
      deposit: "100000",
      network: "testnet",
    });
    await manager.commit(channel.id, "10000");

    await expect(manager.close(channel.id)).rejects.toBeInstanceOf(SettlementMismatchError);
  });

  it("close policy threshold of 1.0 never closes early", async () => {
    // With threshold 1.0 the manager only closes when explicitly called.
    const result = await runHighFrequencyScenario(makeMockOptions(), {
      n: 10,
      closePolicy: { drawdownThreshold: 1.0 },
    });

    // All 10 commits happened before the explicit close.
    expect(result.n).toBe(10);
    expect(result.closeChannelCalls).toBe(1);
  });

  it("throws when called in live mode (requires #173)", async () => {
    const liveOptions: ScenarioOptions = {
      setup: {
        mock: false,
        facilitator: createMockFacilitator(),
        paywall: {
          asset: "USDC",
          payTo: "G",
          network: "testnet",
        },
        payer: async (r) => ({ x402Version: 2, accepted: r, payload: { transaction: "x" } }),
      },
    };
    await expect(runHighFrequencyScenario(liveOptions)).rejects.toThrow(/#173/);
  });
});
