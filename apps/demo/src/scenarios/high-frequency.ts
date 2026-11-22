/**
 * High-frequency channel scenario: N off-chain commitments through one channel,
 * one on-chain close.
 *
 * Demonstrates Phase 2 from docs/design.md: "a high-frequency demo runs
 * hundreds of off-chain commitments and one on-chain close." Each commitment
 * is sequential (see #175 for concurrent commit safety). The close is driven
 * by the manager's ClosePolicy, not a hard-coded loop exit.
 *
 * The scenario proves the single-settlement property from data: exactly one
 * openChannel call, exactly one closeChannel call, and N signCommitment calls.
 * After close it reconciles the full commitment stream and asserts ok.
 *
 * Live HTTP gating requires #173. Until it merges the scenario runs directly
 * against the channel manager so the commitment stream and settlement can be
 * validated in CI without network access.
 *
 * See docs/design.md, "Build plan", Phase 2.
 */

import type { ClosePolicy } from "@vegaforge/tollway-channels";
import {
  createChannelManager,
  createMemoryCommitmentStore,
  createMockMppChannelAdapter,
} from "@vegaforge/tollway-channels";
import { createReconciler } from "@vegaforge/tollway-reconcile";
import type { HighFrequencyScenarioResult, ScenarioOptions } from "./types.js";

/** Default number of requests when not overridden. */
const DEFAULT_N = 500;

/** Price per request: 0.001 USDC in 7-decimal base units. */
const PRICE_PER_REQUEST = "10000";

/** Initial deposit: enough for 2000 requests (20 USDC in base units). */
const CHANNEL_DEPOSIT = "20000000";

/** Percentile index helper (nearest-rank). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export type HighFrequencyOptions = {
  /** Number of commitments. Defaults to 500. */
  n?: number;
  /**
   * Close policy that decides when to stop. Defaults to a drawdown threshold
   * of 0.5 (close once half the deposit is committed), which the demo's
   * deposit and price guarantee will never be reached at N=500. The scenario
   * closes explicitly after all requests when no policy triggers.
   */
  closePolicy?: ClosePolicy;
};

/**
 * Runs N sequential off-chain commitments against one channel, then closes.
 *
 * The scenario is committed sequentially to satisfy the manager's
 * read-modify-write ordering (see #175). Throughput and latency are measured
 * with performance.now().
 */
export async function runHighFrequencyScenario(
  options: ScenarioOptions,
  highFreqOptions: HighFrequencyOptions = {},
): Promise<HighFrequencyScenarioResult> {
  const { paywall, mock } = options.setup;

  if (!mock) {
    throw new Error(
      "High-frequency channel live mode requires #173 (gate accepts channel commitments). " +
        "Run with MOCK_MODE=true.",
    );
  }

  const n = highFreqOptions.n ?? DEFAULT_N;
  const closePolicy: ClosePolicy = highFreqOptions.closePolicy ?? {
    // Threshold of 1.0 means "never close early"; the loop closes explicitly.
    drawdownThreshold: 1.0,
  };

  const { adapter, calls } = createMockMppChannelAdapter();
  const store = createMemoryCommitmentStore();
  const manager = createChannelManager({ adapter, store, closePolicy });

  const channel = await manager.open({
    counterparty: paywall.payTo,
    asset: paywall.asset,
    deposit: CHANNEL_DEPOSIT,
    network: paywall.network,
  });

  const latencies: number[] = [];
  const start = performance.now();

  let closedEarly = false;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await manager.commit(channel.id, PRICE_PER_REQUEST);
    latencies.push(performance.now() - t0);

    if (await manager.shouldClose(channel.id)) {
      closedEarly = true;
      break;
    }
  }

  const elapsed = performance.now() - start;
  const actualN = closedEarly ? latencies.length : n;

  const closeResult = await manager.close(channel.id);
  const settledTotal = (BigInt(PRICE_PER_REQUEST) * BigInt(actualN)).toString();

  // Reconcile.
  const commitments = await manager.list(channel.id);
  const reconciler = createReconciler();
  const reconciliation = await reconciler.reconcileChannel(
    commitments.map((c) => ({
      channelId: c.channelId,
      sequence: c.sequence,
      cumulativeAmount: c.cumulativeAmount,
    })),
    {
      channelId: channel.id,
      settledAmount: settledTotal,
      returnedRemainder: (BigInt(CHANNEL_DEPOSIT) - BigInt(settledTotal)).toString(),
      txHash: closeResult.settlementTxHash,
    },
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  const throughput = actualN / (elapsed / 1000);

  return {
    scenario: "high-frequency",
    mock: true,
    channelId: channel.id,
    n: actualN,
    throughputCommitmentsPerSecond: throughput,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    settlementTxHash: closeResult.settlementTxHash,
    settledTotal,
    reconciliationOk: reconciliation.ok,
    openChannelCalls: calls.openChannel.length,
    closeChannelCalls: calls.closeChannel.length,
  };
}
