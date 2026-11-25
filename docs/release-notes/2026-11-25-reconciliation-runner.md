---
date: 2026-11-25
feature: Scheduled reconciliation runner with cursors and retries
scope: feat
packages: [@vegaforge/tollway-reconcile]
scenario-impact: none
---

# Scheduled reconciliation runner with cursors and retries

The reconciliation runner continuously walks channels and receipts from cursor-based sources, reconciles each item against on-chain state, persists results, retries transient failures, and resumes after a restart without re-alerting or skipping work.

## What changed

`@vegaforge/tollway-reconcile` now exports `createReconciliationRunner`, which orchestrates continuous reconciliation:

- **Cursor-based pagination**: Sources return work in pages with opaque cursors. The runner walks from its last cursor, processes one page, persists results, then advances the cursor. A crash between pages never skips work.
- **Result persistence**: Every reconciliation outcome is keyed by subject (channel or receipt) and run ID. Re-running the same range is idempotent.
- **Retry with backoff**: Transient failures (timeouts, network errors, rate limits) are retried with capped exponential backoff and jitter. After the retry budget is exhausted, the subject is recorded as unverified. Non-transient failures are recorded immediately.
- **Graceful shutdown**: `stop()` cancels the timer, signals in-flight work to abort, and awaits all pending reconciliations.
- **Concurrency limiting**: The runner respects a configurable concurrency limit for reconciliation checks via a semaphore.
- **Unref'd timers**: The interval timer does not prevent the process from exiting when no other work is pending.

## Technical shape

The runner accepts:
- **Sources** (`ChannelReconciliationSource`, `ReceiptReconciliationSource`): Paginated sources of work with opaque cursors.
- **Reconciler**: The reconciliation engine (`createReconciler`) that checks commitments and receipts.
- **Result store** (`ReconciliationResultStore`): Persists outcomes by subject and run.
- **Cursor store** (`CursorStore`): Persists resume positions per source.
- **Configuration**: Interval, page size, concurrency, and retry settings.

Three methods:
- `start()`: Begins continuous scheduled runs.
- `stop()`: Stops gracefully, awaiting in-flight work.
- `runOnce()`: Runs one full pass (for tests and cron).

Memory implementations of all stores are exported for development and testing. Production stores (PostgreSQL, Redis) implement the same interfaces.

## Usage

```typescript
import {
  createReconciler,
  createReconciliationRunner,
  createMemoryCursorStore,
  createMemoryReconciliationResultStore,
  type ChannelReconciliationSource,
} from "@vegaforge/tollway-reconcile";

const channelSource: ChannelReconciliationSource = {
  async listChannels(cursor, limit) {
    // Fetch channels ready for reconciliation.
    return { items, nextCursor };
  },
};

const runner = createReconciliationRunner({
  sources: { channels: channelSource },
  reconciler: createReconciler(),
  results: createMemoryReconciliationResultStore(),
  cursors: createMemoryCursorStore(),
  intervalMs: 60000,
  pageSize: 50,
  concurrency: 10,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 30000,
    jitter: true,
  },
});

await runner.start();
// Later: await runner.stop();
```

## Documentation

- `docs/reconciliation-runner.md`: Full guide with architecture, configuration, stores, retry behavior, and integration points.
- `examples/reconciliation-runner-demo.ts`: Runnable example with mock data showing 100 channels with drift cases.

## Related

Closes #213. This is the scheduling and orchestration layer for the reconciliation engine added in earlier releases. The runner makes reconciliation continuous and resilient, as described in `docs/design.md` ("Reconciliation" section).

Future work:
- Receipt archive (#222) will feed the receipt source once cursor-paginated listing lands.
- On-chain settlement confirmation for x402 and MPP charge will be integrated when RPC lookup is added.
- Persistent stores (PostgreSQL, Redis) for cursors and results for production deployments.
