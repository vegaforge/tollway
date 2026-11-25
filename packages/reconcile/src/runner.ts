/**
 * Scheduled reconciliation runner that walks receipts and channels from
 * cursors, calls on-chain checks, persists results, retries transient
 * failures, and resumes after a restart without re-alerting or skipping.
 *
 * Issue #213: continuous reconciliation with cursor-based pagination.
 */

import type {
  CommitmentRecord,
  Reconciler,
  ReconciliationResult,
  SettlementRecord,
} from "./index.js";

/** Opaque cursor token for pagination. */
export type Cursor = string;

/** One page of work to reconcile. */
export type Page<T> = {
  items: readonly T[];
  nextCursor?: Cursor;
};

/**
 * Source of channels to reconcile. Returns channels with their commitments
 * and settlements in cursor-paginated batches.
 */
export interface ChannelReconciliationSource {
  /**
   * Fetches one page of channels ready for reconciliation. A channel is
   * included when it has a settlement (closed channels) or when periodic
   * live checks are due (open channels, out of scope for v0).
   */
  listChannels(cursor?: Cursor, limit?: number): Promise<Page<ChannelReconciliationInput>>;
}

/**
 * One channel with its commitment stream and settlement to reconcile.
 * For closed channels, the settlement is present. For open channels (periodic
 * live checks), it is absent; that path is deferred beyond v0.
 */
export type ChannelReconciliationInput = {
  channelId: string;
  commitments: CommitmentRecord[];
  settlement?: SettlementRecord;
};

/**
 * Source of receipts to reconcile. Returns signed receipts for which
 * settlement confirmation is needed.
 */
export interface ReceiptReconciliationSource {
  /**
   * Fetches one page of receipts that need on-chain settlement confirmation.
   * On-chain lookup is tracked separately and is out of scope for the runner.
   */
  listReceipts(cursor?: Cursor, limit?: number): Promise<Page<ReceiptReconciliationInput>>;
}

/** One receipt to reconcile. */
export type ReceiptReconciliationInput = {
  receiptId: string;
  // On-chain settlement check is tracked separately; the runner only
  // orchestrates the structural reconciliation for now.
};

/** What one runner check is about: a tracked channel, or a stored receipt. */
export type RunSubject =
  | { kind: "channel"; channelId: string }
  | { kind: "receipt"; receiptId: string };

/** The outcome of reconciling one subject in one run. */
export type ReconciliationOutcome = {
  subject: RunSubject;
  runId: string;
  /** ISO-8601 timestamp when the check ran. */
  timestamp: string;
  result: ReconciliationResult | ReconciliationFailure;
};

/**
 * A reconciliation that could not complete. Transient failures are retried;
 * after the retry budget is exhausted, the subject is recorded as unverified.
 */
export type ReconciliationFailure = {
  ok: false;
  kind: "unverified" | "transient";
  error: string;
  /** Set when retries are exhausted and the subject remains unverified. */
  retriesExhausted?: boolean;
};

/** Persists reconciliation outcomes keyed by subject and run. */
export interface ReconciliationResultStore {
  /**
   * Records the outcome for a subject in a run. Re-running the same range is
   * idempotent: the same subject and run produce the same stored entry.
   */
  put(outcome: ReconciliationOutcome): Promise<void>;

  /**
   * Retrieves the most recent outcome for a subject, if any. Used to decide
   * whether a subject needs re-reconciliation.
   */
  get(subject: RunSubject): Promise<ReconciliationOutcome | undefined>;

  /**
   * Lists all outcomes for a run, ordered by timestamp. Used for reporting
   * and to verify idempotency in tests.
   */
  listByRun(runId: string): Promise<readonly ReconciliationOutcome[]>;
}

/** Configuration for the reconciliation runner. */
export type ReconciliationRunnerConfig = {
  /** Sources of work. At least one must be provided. */
  sources: {
    channels?: ChannelReconciliationSource;
    receipts?: ReceiptReconciliationSource;
  };
  /** The reconciliation engine that checks commitments and receipts. */
  reconciler: Reconciler;
  /** Where reconciliation outcomes are persisted. */
  results: ReconciliationResultStore;
  /** Where the runner's cursor positions are persisted. */
  cursors: CursorStore;
  /** Interval between runs in milliseconds. Defaults to 60000 (1 minute). */
  intervalMs?: number;
  /** Page size for pagination. Defaults to 50. */
  pageSize?: number;
  /** Maximum concurrent reconciliation checks. Defaults to 10. */
  concurrency?: number;
  /** Retry configuration for transient failures. */
  retry?: RetryConfig;
};

/** Persists cursor positions so the runner can resume after a restart. */
export interface CursorStore {
  /** Retrieves the cursor for a source, if any. */
  get(source: "channels" | "receipts"): Promise<Cursor | undefined>;
  /**
   * Persists the cursor for a source. Cursors are persisted only after the
   * results for that page are persisted, so a crash never skips work.
   */
  put(source: "channels" | "receipts", cursor: Cursor | undefined): Promise<void>;
}

/** Retry configuration for transient failures. */
export type RetryConfig = {
  /** Maximum number of retry attempts. Defaults to 3. */
  maxAttempts?: number;
  /** Initial backoff delay in milliseconds. Defaults to 1000. */
  initialDelayMs?: number;
  /** Backoff multiplier for exponential backoff. Defaults to 2. */
  backoffMultiplier?: number;
  /** Maximum backoff delay in milliseconds. Defaults to 30000. */
  maxDelayMs?: number;
  /** Whether to add jitter to backoff delays. Defaults to true. */
  jitter?: boolean;
};

/** The reconciliation runner. */
export interface ReconciliationRunner {
  /** Starts the scheduled runner. */
  start(): Promise<void>;
  /** Stops the runner gracefully, awaiting in-flight work. */
  stop(): Promise<void>;
  /** Runs one full pass for tests and cron use. */
  runOnce(): Promise<void>;
}

/** In-flight retry state for one subject. */
type RetryState = {
  subject: RunSubject;
  /** What to check again; a retry re-runs the same input. */
  input:
    | { kind: "channel"; value: ChannelReconciliationInput }
    | { kind: "receipt"; value: ReceiptReconciliationInput };
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
};

/**
 * Creates a reconciliation runner that walks sources from cursors, reconciles
 * each item, persists results, and retries transient failures.
 */
export function createReconciliationRunner(
  config: ReconciliationRunnerConfig,
): ReconciliationRunner {
  const {
    sources,
    reconciler,
    results,
    cursors,
    intervalMs = 60000,
    pageSize = 50,
    concurrency = 10,
    retry = {},
  } = config;

  const retryConfig: Required<RetryConfig> = {
    maxAttempts: retry.maxAttempts ?? 3,
    initialDelayMs: retry.initialDelayMs ?? 1000,
    backoffMultiplier: retry.backoffMultiplier ?? 2,
    maxDelayMs: retry.maxDelayMs ?? 30000,
    jitter: retry.jitter ?? true,
  };

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let abortController: AbortController | undefined;
  const inflightPromises: Set<Promise<void>> = new Set();
  const retryQueue: Map<string, RetryState> = new Map();
  const semaphore = new Semaphore(concurrency);

  async function reconcileChannel(
    input: ChannelReconciliationInput,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const subject: RunSubject = { kind: "channel", channelId: input.channelId };
    const subjectKey = serializeSubject(subject);

    try {
      await semaphore.acquire(signal);
      // The finally block releases the permit; releasing here as well would
      // hand out one permit too many.
      if (signal.aborted) return;

      let result: ReconciliationResult | ReconciliationFailure;

      if (input.settlement) {
        result = await reconciler.reconcileChannel(input.commitments, input.settlement);
      } else {
        // An open channel has no settlement to compare yet. Its live check
        // (checkOpenChannel with a contract snapshot) is not wired into the
        // runner, so it is reported as unverified, not as consistent (#365).
        result = {
          ok: false,
          kind: "unverified",
          error: "open-channel checks are not implemented in the runner yet (#365)",
        };
      }

      const outcome: ReconciliationOutcome = {
        subject,
        runId,
        timestamp: new Date().toISOString(),
        result,
      };

      await results.put(outcome);

      // Clear retry state on success.
      retryQueue.delete(subjectKey);
    } catch (error) {
      await handleFailure(subject, runId, error, signal, { kind: "channel", value: input });
    } finally {
      semaphore.release();
    }
  }

  async function reconcileReceipt(
    input: ReceiptReconciliationInput,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const subject: RunSubject = { kind: "receipt", receiptId: input.receiptId };
    const subjectKey = serializeSubject(subject);

    try {
      await semaphore.acquire(signal);
      // The finally block releases the permit; releasing here as well would
      // hand out one permit too many.
      if (signal.aborted) return;

      // Receipts are not checked yet: the runner has only a receipt id, and
      // confirming one on chain needs the signed receipt (reconcileCharge).
      // Report it as unverified rather than claiming it is consistent; the
      // receipt check is tracked in #365.
      const result: ReconciliationFailure = {
        ok: false,
        kind: "unverified",
        error: "receipt reconciliation is not implemented in the runner yet (#365)",
      };

      const outcome: ReconciliationOutcome = {
        subject,
        runId,
        timestamp: new Date().toISOString(),
        result,
      };

      await results.put(outcome);

      // Clear retry state on success.
      retryQueue.delete(subjectKey);
    } catch (error) {
      await handleFailure(subject, runId, error, signal, { kind: "receipt", value: input });
    } finally {
      semaphore.release();
    }
  }

  async function handleFailure(
    subject: RunSubject,
    runId: string,
    error: unknown,
    signal: AbortSignal,
    input: RetryState["input"],
  ): Promise<void> {
    if (signal.aborted) return;

    const subjectKey = serializeSubject(subject);
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if this is a transient failure that should be retried.
    const isTransient = isTransientError(error);

    if (!isTransient) {
      // Non-transient failures are recorded immediately.
      const outcome: ReconciliationOutcome = {
        subject,
        runId,
        timestamp: new Date().toISOString(),
        result: {
          ok: false,
          kind: "unverified",
          error: errorMessage,
        },
      };
      await results.put(outcome);
      retryQueue.delete(subjectKey);
      return;
    }

    // Transient failure: schedule retry with exponential backoff.
    const existing = retryQueue.get(subjectKey);
    const attempts = (existing?.attempts ?? 0) + 1;

    if (attempts > retryConfig.maxAttempts) {
      // Retry budget exhausted.
      const outcome: ReconciliationOutcome = {
        subject,
        runId,
        timestamp: new Date().toISOString(),
        result: {
          ok: false,
          kind: "unverified",
          error: errorMessage,
          retriesExhausted: true,
        },
      };
      await results.put(outcome);
      retryQueue.delete(subjectKey);
      return;
    }

    // Calculate backoff delay with optional jitter.
    const baseDelay = Math.min(
      retryConfig.initialDelayMs * retryConfig.backoffMultiplier ** (attempts - 1),
      retryConfig.maxDelayMs,
    );
    const delay = retryConfig.jitter ? baseDelay * (0.5 + Math.random() * 0.5) : baseDelay;

    // Record the transient failure now, so the result store shows the
    // subject as pending a retry rather than missing.
    await results.put({
      subject,
      runId,
      timestamp: new Date().toISOString(),
      result: { ok: false, kind: "transient", error: errorMessage },
    });
    retryQueue.set(subjectKey, {
      subject,
      input,
      attempts,
      nextAttemptAt: Date.now() + delay,
      lastError: errorMessage,
    });
  }

  /** Re-runs every retry that is due. A retry that fails again reschedules itself. */
  async function processRetries(runId: string, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const ready = [...retryQueue.values()].filter((state) => state.nextAttemptAt <= now);
    await Promise.all(
      ready.map((state) => {
        if (signal.aborted) return Promise.resolve();
        return state.input.kind === "channel"
          ? reconcileChannel(state.input.value, runId, signal)
          : reconcileReceipt(state.input.value, runId, signal);
      }),
    );
  }

  async function runChannels(runId: string, signal: AbortSignal): Promise<void> {
    if (!sources.channels || signal.aborted) return;

    let cursor = await cursors.get("channels");

    while (!signal.aborted) {
      const page = await sources.channels.listChannels(cursor, pageSize);

      if (page.items.length === 0) break;

      const promises: Promise<void>[] = [];
      for (const input of page.items) {
        if (signal.aborted) break;
        const promise = reconcileChannel(input, runId, signal);
        inflightPromises.add(promise);
        promises.push(
          promise.finally(() => {
            inflightPromises.delete(promise);
          }),
        );
      }

      await Promise.all(promises);

      // Persist cursor only after results for this page are persisted.
      cursor = page.nextCursor;
      await cursors.put("channels", cursor);

      if (!page.nextCursor) break;
    }
  }

  async function runReceipts(runId: string, signal: AbortSignal): Promise<void> {
    if (!sources.receipts || signal.aborted) return;

    let cursor = await cursors.get("receipts");

    while (!signal.aborted) {
      const page = await sources.receipts.listReceipts(cursor, pageSize);

      if (page.items.length === 0) break;

      const promises: Promise<void>[] = [];
      for (const input of page.items) {
        if (signal.aborted) break;
        const promise = reconcileReceipt(input, runId, signal);
        inflightPromises.add(promise);
        promises.push(
          promise.finally(() => {
            inflightPromises.delete(promise);
          }),
        );
      }

      await Promise.all(promises);

      // Persist cursor only after results for this page are persisted.
      cursor = page.nextCursor;
      await cursors.put("receipts", cursor);

      if (!page.nextCursor) break;
    }
  }

  async function runOnce(): Promise<void> {
    const controller = new AbortController();
    const runId = generateRunId();

    try {
      // Due retries run after this run's fresh checks, so a subject that
      // fails in this run waits for its backoff before it is tried again.
      await processRetries(runId, controller.signal);
      await Promise.all([
        runChannels(runId, controller.signal),
        runReceipts(runId, controller.signal),
      ]);
    } finally {
      // Wait for all in-flight work to complete.
      await Promise.all([...inflightPromises]);
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const controller = new AbortController();
      abortController = controller;

      try {
        await runOnce();
      } catch (error) {
        // Log error but continue the loop.
        console.error("Reconciliation run failed:", error);
      }

      if (!running) break;

      // Schedule next run with an unref'd timer so it doesn't prevent exit.
      await new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          resolve();
        }, intervalMs);
        timer.unref();
      });
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      await loop();
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      // Cancel in-flight work.
      abortController?.abort();

      // Clear the timer.
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      // Wait for all in-flight work to complete.
      await Promise.all([...inflightPromises]);
    },

    runOnce,
  };
}

/** Semaphore for concurrency limiting. */
class Semaphore {
  private permits: number;
  private queue: Array<{ resolve: () => void; signal?: AbortSignal }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, signal };
      this.queue.push(entry);

      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(new Error("Aborted"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  release(): void {
    const entry = this.queue.shift();
    if (entry && !entry.signal?.aborted) {
      entry.resolve();
    } else {
      this.permits++;
    }
  }
}

function serializeSubject(subject: RunSubject): string {
  return subject.kind === "channel"
    ? `channel:${subject.channelId}`
    : `receipt:${subject.receiptId}`;
}

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("unavailable") ||
    message.includes("rate limit")
  );
}

/** Memory-based cursor store for development and testing. */
export function createMemoryCursorStore(): CursorStore {
  const cursors = new Map<string, Cursor | undefined>();

  return {
    async get(source) {
      return cursors.get(source);
    },
    async put(source, cursor) {
      cursors.set(source, cursor);
    },
  };
}

/** Memory-based reconciliation result store for development and testing. */
export function createMemoryReconciliationResultStore(): ReconciliationResultStore {
  const outcomes = new Map<string, ReconciliationOutcome>();
  const byRun = new Map<string, ReconciliationOutcome[]>();

  return {
    async put(outcome) {
      const key = serializeSubject(outcome.subject);
      outcomes.set(key, outcome);

      let runOutcomes = byRun.get(outcome.runId);
      if (runOutcomes === undefined) {
        runOutcomes = [];
        byRun.set(outcome.runId, runOutcomes);
      }
      const existingIndex = runOutcomes.findIndex(
        (o) => serializeSubject(o.subject) === key && o.runId === outcome.runId,
      );
      if (existingIndex !== -1) {
        runOutcomes[existingIndex] = outcome;
      } else {
        runOutcomes.push(outcome);
      }
    },

    async get(subject) {
      const key = serializeSubject(subject);
      return outcomes.get(key);
    },

    async listByRun(runId) {
      const runOutcomes = byRun.get(runId) ?? [];
      return [...runOutcomes].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    },
  };
}

/** Memory-based channel reconciliation source for testing. */
export function createMemoryChannelReconciliationSource(
  channels: ChannelReconciliationInput[],
): ChannelReconciliationSource {
  return {
    async listChannels(cursor, limit = 50) {
      let startIndex = 0;
      if (cursor) {
        startIndex = Number.parseInt(cursor, 10);
        if (Number.isNaN(startIndex)) startIndex = 0;
      }

      const items = channels.slice(startIndex, startIndex + limit);
      const nextCursor =
        startIndex + limit < channels.length ? String(startIndex + limit) : undefined;

      return { items, nextCursor };
    },
  };
}

/** Memory-based receipt reconciliation source for testing. */
export function createMemoryReceiptReconciliationSource(
  receipts: ReceiptReconciliationInput[],
): ReceiptReconciliationSource {
  return {
    async listReceipts(cursor, limit = 50) {
      let startIndex = 0;
      if (cursor) {
        startIndex = Number.parseInt(cursor, 10);
        if (Number.isNaN(startIndex)) startIndex = 0;
      }

      const items = receipts.slice(startIndex, startIndex + limit);
      const nextCursor =
        startIndex + limit < receipts.length ? String(startIndex + limit) : undefined;

      return { items, nextCursor };
    },
  };
}
