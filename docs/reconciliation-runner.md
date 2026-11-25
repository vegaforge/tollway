# Reconciliation Runner

The reconciliation runner continuously walks channels and receipts from cursor-based sources, reconciles each item against on-chain state, persists results, retries transient failures, and resumes after a restart without re-alerting or skipping work.

**Issue:** #213

## Purpose

The reconciliation engine (`createReconciler`) exposes pure functions that check commitments and receipts for drift, but provides no scheduling, no source of work, and no result storage. The runner fills this gap: it makes reconciliation continuous and resilient.

For channel mode, the runner compares stored commitment streams against on-chain settlements. For x402 and MPP charge mode, it confirms settlements landed on chain (on-chain lookup integration is deferred beyond v0).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Reconciliation Runner                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Channel    │    │   Receipt    │    │    Retry     │  │
│  │   Source     │    │   Source     │    │    Queue     │  │
│  │  (paginated) │    │  (paginated) │    │  (backoff)   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                     │          │
│         ├───────────────────┴─────────────────────┤          │
│         │            Reconcile Items              │          │
│         │          (concurrency limited)          │          │
│         └────────────────┬──────────────────────┘          │
│                          │                                   │
│         ┌────────────────┴──────────────────┐              │
│         │  Persist Results, then Cursors    │              │
│         │      (crash-safe ordering)        │              │
│         └────────────────┬──────────────────┘              │
│                          │                                   │
│  ┌──────────────────────┴────────────────────────────┐    │
│  │  Result Store (by subject + run)                   │    │
│  │  Cursor Store (resume position per source)         │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Key Properties

### Cursor-based pagination

Sources return work in pages with opaque cursors. The runner walks each source from its last cursor, processes one page, persists results, then persists the new cursor. A crash between pages never skips work: the cursor only advances after results for that page are stored.

### Idempotency

Re-running the same range produces the same stored results. Each outcome is keyed by subject (channel or receipt) and run ID. If a run is repeated (e.g., after a rollback or manual re-reconciliation), the same subject produces the same entry.

### Retry with backoff

Transient failures (network timeouts, rate limits, temporary unavailability) are retried with capped exponential backoff and optional jitter. After the retry budget is exhausted, the subject is recorded as `unverified` with `retriesExhausted: true`. Non-transient failures (malformed data, validation errors) are recorded immediately without retry.

### Graceful shutdown

Calling `stop()` cancels the timer, signals in-flight work to abort, and awaits all pending reconciliations before resolving. No work is abandoned mid-flight.

### Concurrency limiting

The runner respects a configurable concurrency limit for reconciliation checks. The semaphore ensures at most N checks run concurrently, preventing RPC overload.

### Unref'd timers

The interval timer is marked `unref()`, so it does not prevent the process from exiting when no other work is pending.

## Usage

### Basic setup

```typescript
import {
  createReconciler,
  createReconciliationRunner,
  createMemoryCursorStore,
  createMemoryReconciliationResultStore,
  type ChannelReconciliationSource,
} from "@vegaforge/tollway-reconcile";

// Implement or use a channel source.
const channelSource: ChannelReconciliationSource = {
  async listChannels(cursor, limit) {
    // Fetch channels ready for reconciliation from your store.
    // Return { items, nextCursor }.
  },
};

const reconciler = createReconciler();
const results = createMemoryReconciliationResultStore();
const cursors = createMemoryCursorStore();

const runner = createReconciliationRunner({
  sources: { channels: channelSource },
  reconciler,
  results,
  cursors,
  intervalMs: 60000, // Run every minute.
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

// Start continuous reconciliation.
await runner.start();

// Later, stop gracefully.
await runner.stop();
```

### One-time run (cron or tests)

```typescript
await runner.runOnce();
```

A single pass walks each source from its cursor to the end, then stops. Useful for cron jobs, manual triggers, and tests.

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sources.channels` | `ChannelReconciliationSource?` | — | Source of channels to reconcile. |
| `sources.receipts` | `ReceiptReconciliationSource?` | — | Source of receipts to reconcile. |
| `reconciler` | `Reconciler` | — | The reconciliation engine. |
| `results` | `ReconciliationResultStore` | — | Where outcomes are persisted. |
| `cursors` | `CursorStore` | — | Where cursor positions are persisted. |
| `intervalMs` | `number` | `60000` | Interval between runs (ms). |
| `pageSize` | `number` | `50` | Page size for pagination. |
| `concurrency` | `number` | `10` | Max concurrent reconciliation checks. |
| `retry.maxAttempts` | `number` | `3` | Max retry attempts for transient failures. |
| `retry.initialDelayMs` | `number` | `1000` | Initial backoff delay (ms). |
| `retry.backoffMultiplier` | `number` | `2` | Exponential backoff multiplier. |
| `retry.maxDelayMs` | `number` | `30000` | Max backoff delay (ms). |
| `retry.jitter` | `boolean` | `true` | Add jitter to backoff delays. |

At least one source (`channels` or `receipts`) must be provided.

## Sources

### ChannelReconciliationSource

Returns channels ready for reconciliation. For closed channels, the settlement is included. For open channels (periodic live checks, deferred beyond v0), it may be absent.

```typescript
interface ChannelReconciliationSource {
  listChannels(
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ChannelReconciliationInput>>;
}

type ChannelReconciliationInput = {
  channelId: string;
  commitments: CommitmentRecord[];
  settlement?: SettlementRecord;
};
```

**Implementation notes:**

- Cursors are opaque strings. The source defines their format.
- A missing `cursor` means start from the beginning.
- `nextCursor` absent means no more pages.
- For memory sources, the cursor can be a stringified offset. For SQL sources, it can encode keyset pagination values.

### ReceiptReconciliationSource

Returns receipts for which settlement confirmation is needed. On-chain lookup integration is deferred beyond v0; the runner only orchestrates structural reconciliation for now.

```typescript
interface ReceiptReconciliationSource {
  listReceipts(
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ReceiptReconciliationInput>>;
}

type ReceiptReconciliationInput = {
  receiptId: string;
};
```

## Stores

### ReconciliationResultStore

Persists outcomes keyed by subject (channel or receipt) and run ID.

```typescript
interface ReconciliationResultStore {
  put(outcome: ReconciliationOutcome): Promise<void>;
  get(subject: ReconciliationSubject): Promise<ReconciliationOutcome | undefined>;
  listByRun(runId: string): Promise<readonly ReconciliationOutcome[]>;
}

type ReconciliationOutcome = {
  subject: ReconciliationSubject;
  runId: string;
  timestamp: string; // ISO-8601
  result: ReconciliationResult | ReconciliationFailure;
};

type ReconciliationSubject =
  | { kind: "channel"; channelId: string }
  | { kind: "receipt"; receiptId: string };
```

**Memory implementation:**

```typescript
import { createMemoryReconciliationResultStore } from "@vegaforge/tollway-reconcile";

const results = createMemoryReconciliationResultStore();
```

**Production stores:**

For PostgreSQL or Redis, implement the interface with your schema. Results should be keyed by `serializeSubject(subject)` and indexed by `runId` for efficient listing.

### CursorStore

Persists the runner's cursor position per source, so it can resume after a restart.

```typescript
interface CursorStore {
  get(source: "channels" | "receipts"): Promise<Cursor | undefined>;
  put(source: "channels" | "receipts", cursor: Cursor | undefined): Promise<void>;
}
```

**Memory implementation:**

```typescript
import { createMemoryCursorStore } from "@vegaforge/tollway-reconcile";

const cursors = createMemoryCursorStore();
```

**Persistence:**

The cursor is persisted only after results for a page are stored, so a crash never skips work. For SQL stores, wrap the result writes and cursor update in a transaction.

## Retry behavior

Transient failures are retried. The runner identifies transient errors by message content:

- `timeout`
- `network`
- `econnrefused`
- `enotfound`
- `unavailable`
- `rate limit`

Other errors are treated as non-transient and recorded immediately as `unverified`.

**Retry schedule:**

Backoff delay = `min(initialDelayMs * backoffMultiplier^(attempts - 1), maxDelayMs)`

With jitter, the actual delay is `baseDelay * (0.5 + random() * 0.5)`.

After `maxAttempts`, the subject is recorded with `retriesExhausted: true`.

## Run ID

Each `runOnce()` generates a unique run ID: `run-<timestamp>-<random>`. Outcomes for a run can be listed via `results.listByRun(runId)` for auditing and reporting.

## Integration with alerts

Reconciliation outcomes can be fed into the drift alert system (`createDriftAlertBridge`, see `alerts.ts`). Poll the result store or add an event emitter to `put()` for real-time alerting.

## Example

See `examples/reconciliation-runner-demo.ts` for a runnable example with mock data.

## Testing

Tests use `vi.useFakeTimers()` to control backoff delays and interval timing. All runner behaviors (pagination, cursor persistence order, crash recovery, retries, graceful stop, idempotency) are covered in `runner.test.ts`.

## Relationship to other components

- **Reconciler (`createReconciler`)**: The pure reconciliation logic. The runner orchestrates it.
- **Drift alerts (`createDriftAlertBridge`)**: Consumes reconciliation outcomes to emit alerts. The runner produces outcomes; the bridge reacts to them.
- **Quarantine enforcer (`createQuarantineEnforcer`)**: Processes reconciliation results to quarantine channels with unacceptable drift. The runner outputs results; the enforcer applies policy.
- **Commitment stores**: The source of commitment streams. `CommitmentStore.listChannels` feeds the runner's channel source (once #177, #178, #179 land).

## Future work

- **Receipt archive (#222)**: Once receipts are archived with cursor-paginated listing, the receipt source can be implemented against that archive.
- **On-chain settlement confirmation**: Integrate Stellar RPC or Horizon lookups to confirm x402 and MPP charge settlements landed on chain.
- **Open channel live checks**: Periodically reconcile open channels against their current on-chain state to detect drift before close.
- **Persistent stores**: PostgreSQL and Redis implementations of `CursorStore` and `ReconciliationResultStore` for production use.
- **Metrics and observability**: Emit counters (reconciled, ok, drift, retries) and gauges (retry queue depth, cursor positions) for monitoring.
