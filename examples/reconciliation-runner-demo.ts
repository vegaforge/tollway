/**
 * Example script demonstrating the reconciliation runner in mock mode.
 *
 * This shows how to set up a continuous reconciliation worker that walks
 * channels and receipts from cursors, reconciles them, persists results,
 * and handles retries.
 *
 * Run with: pnpm tsx examples/reconciliation-runner-demo.ts
 */

import {
  type ChannelReconciliationInput,
  createMemoryChannelReconciliationSource,
  createMemoryCursorStore,
  createMemoryReconciliationResultStore,
  createReconciler,
  createReconciliationRunner,
} from "@vegaforge/tollway-reconcile";

// Generate mock channel data for demonstration.
function generateMockChannels(count: number): ChannelReconciliationInput[] {
  return Array.from({ length: count }, (_, i) => {
    const channelId = `demo-channel-${i.toString().padStart(4, "0")}`;
    const committed = BigInt((i + 1) * 1000000); // 1M, 2M, 3M, etc.

    // Simulate some drift cases.
    let settledAmount = committed.toString();
    if (i % 20 === 0) {
      // Every 20th channel under-settles by 10%.
      settledAmount = (committed * 9n / 10n).toString();
    } else if (i % 30 === 0) {
      // Every 30th channel over-settles by 5%.
      settledAmount = (committed * 105n / 100n).toString();
    }

    return {
      channelId,
      commitments: [
        {
          channelId,
          sequence: 0,
          cumulativeAmount: (committed / 2n).toString(),
        },
        {
          channelId,
          sequence: 1,
          cumulativeAmount: committed.toString(),
        },
      ],
      settlement: {
        channelId,
        settledAmount,
        returnedRemainder: "50000", // 0.05 XLM remainder
        txHash: `demo-tx-${channelId}`,
      },
    };
  });
}

async function main() {
  console.log("=== Reconciliation Runner Demo ===\n");

  // Generate 100 mock channels with some drift cases.
  const channels = generateMockChannels(100);
  console.log(`Generated ${channels.length} mock channels\n`);

  // Set up the reconciliation infrastructure.
  const channelSource = createMemoryChannelReconciliationSource(channels);
  const results = createMemoryReconciliationResultStore();
  const cursors = createMemoryCursorStore();
  const reconciler = createReconciler({
    // Optional: suppress specific drift kinds for demonstration.
    suppress: (drift) => {
      // In production, you might suppress known-acceptable divergences.
      return false;
    },
  });

  // Create the runner with configuration.
  const runner = createReconciliationRunner({
    sources: {
      channels: channelSource,
      // receipts: receiptSource, // Could add receipt source too.
    },
    reconciler,
    results,
    cursors,
    intervalMs: 10000, // Run every 10 seconds.
    pageSize: 25, // Process 25 channels per page.
    concurrency: 5, // Check up to 5 channels concurrently.
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 30000,
      jitter: true,
    },
  });

  console.log("Configuration:");
  console.log("  - Page size: 25 channels");
  console.log("  - Concurrency: 5 concurrent checks");
  console.log("  - Retry: up to 3 attempts with exponential backoff");
  console.log("  - Interval: 10 seconds between runs\n");

  // Run once to demonstrate the reconciliation.
  console.log("Starting reconciliation run...\n");

  const startTime = Date.now();
  await runner.runOnce();
  const duration = Date.now() - startTime;

  console.log(`\nReconciliation run completed in ${duration}ms\n`);

  // Analyze results.
  const stats = {
    total: 0,
    ok: 0,
    drift: 0,
    underSettled: 0,
    overSettled: 0,
  };

  for (const channel of channels) {
    const outcome = await results.get({ kind: "channel", channelId: channel.channelId });
    if (outcome) {
      stats.total++;
      if (outcome.result.ok) {
        stats.ok++;
      } else {
        stats.drift++;
        const drifts = outcome.result.drift ?? [];
        for (const drift of drifts) {
          if (drift.kind === "under-settled") stats.underSettled++;
          if (drift.kind === "over-settled") stats.overSettled++;
        }
      }
    }
  }

  console.log("Results:");
  console.log(`  - Total reconciled: ${stats.total}`);
  console.log(`  - OK (no drift): ${stats.ok}`);
  console.log(`  - Drift detected: ${stats.drift}`);
  console.log(`    - Under-settled: ${stats.underSettled}`);
  console.log(`    - Over-settled: ${stats.overSettled}`);
  console.log();

  // Show some example drift cases.
  console.log("Example drift cases:");
  let driftCount = 0;
  for (const channel of channels) {
    if (driftCount >= 3) break;

    const outcome = await results.get({ kind: "channel", channelId: channel.channelId });
    if (outcome && !outcome.result.ok) {
      driftCount++;
      console.log(`\n  Channel: ${channel.channelId}`);
      const drifts = outcome.result.drift ?? [];
      for (const drift of drifts) {
        console.log(`    - ${drift.kind}: ${drift.detail}`);
      }
    }
  }

  console.log("\n=== Demo Complete ===");
  console.log("\nIn production:");
  console.log("  - Use runner.start() for continuous scheduled runs");
  console.log("  - Connect real channel and receipt sources");
  console.log("  - Integrate with alerting systems via the DriftAlertBridge");
  console.log("  - Use persistent stores (PostgreSQL, Redis) for cursors and results");
  console.log("  - Monitor via observability hooks and metrics");
}

// Run the demo.
main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
