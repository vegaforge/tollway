/**
 * Event ingest transport (#229): a batching sink that carries receipts, payment
 * metrics and lifecycle events from a gate or client to the Tollway service.
 *
 * - Emitting is synchronous and never awaits the network; the payment path
 *   only pushes into a bounded buffer.
 * - Batches flush by size or interval, whichever comes first.
 * - Each batch carries an idempotency key so a retry after a lost response
 *   can be deduplicated by the service.
 * - Retries use exponential backoff with jitter. 429 honours Retry-After.
 *   Other 4xx responses are not retried and are reported.
 * - Overflow never throws. Receipts are never dropped silently: when the
 *   buffer is full the oldest metric is dropped first, and every drop is
 *   reported through onDrop.
 * - The API key is sent only in the Authorization header. Errors and drop
 *   reports carry status codes and counts, never the key.
 *
 * Delivery is at-least-once to the service, deduplicated there by batch key.
 * The buffer is in memory, so items not yet flushed are lost on a crash.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";

export type SinkItem =
  | { kind: "receipt"; payload: SignedReceipt }
  | { kind: "metric"; payload: unknown }
  | { kind: "event"; payload: unknown };

export type DropReport = {
  kind: SinkItem["kind"];
  count: number;
  reason: "buffer-full" | "rejected" | "shutdown-deadline";
};

export type ServiceSinkOptions = {
  /** Base URL of the Tollway service, for example https://tollway.example.com */
  url: string;
  apiKey: string;
  /** Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  onDrop?: (report: DropReport) => void;
  onFlushError?: (error: Error) => void;
};

export type ServiceSink = {
  /** Observer shape used by the gate's createPaywall observer. */
  record(metric: unknown): void;
  emit(event: unknown): void;
  /** Queues a signed receipt for the archive. */
  receipt(receipt: SignedReceipt): void;
  flush(): Promise<void>;
  /** Flushes and waits up to deadlineMs. Anything still queued is reported as dropped. */
  close(deadlineMs?: number): Promise<void>;
};

const DEFAULTS = {
  batchSize: 100,
  flushIntervalMs: 1000,
  maxBuffer: 10_000,
  maxAttempts: 5,
  baseBackoffMs: 250,
  maxBackoffMs: 10_000,
  requestTimeoutMs: 10_000,
} as const;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void };
  maybe.unref?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function createServiceSink(options: ServiceSinkOptions): ServiceSink {
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const maxBuffer = options.maxBuffer ?? DEFAULTS.maxBuffer;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/ingest`;

  let buffer: SinkItem[] = [];
  let flushing: Promise<void> | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drop = (kind: SinkItem["kind"], count: number, reason: DropReport["reason"]) => {
    if (count > 0) options.onDrop?.({ kind, count, reason });
  };

  const scheduleFlush = () => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, options.flushIntervalMs ?? DEFAULTS.flushIntervalMs);
    unrefTimer(timer);
  };

  const enqueue = (item: SinkItem) => {
    if (closed) {
      drop(item.kind, 1, "shutdown-deadline");
      return;
    }
    if (buffer.length >= maxBuffer) {
      const oldestMetric = buffer.findIndex((queued) => queued.kind === "metric");
      if (oldestMetric >= 0) {
        buffer.splice(oldestMetric, 1);
        drop("metric", 1, "buffer-full");
      } else {
        // No metric to shed: refuse the incoming item and report it.
        drop(item.kind, 1, "buffer-full");
        return;
      }
    }
    buffer.push(item);
    if (buffer.length >= batchSize) {
      void flush();
    } else {
      scheduleFlush();
    }
  };

  async function sendBatch(batch: SinkItem[]): Promise<void> {
    const body = JSON.stringify({ idempotencyKey: crypto.randomUUID(), items: batch });
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), requestTimeoutMs);
      unrefTimer(abort);
      let retryWait: number | undefined;
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable) {
          drop(batch[0].kind, batch.length, "rejected");
          options.onFlushError?.(new Error(`ingest rejected the batch with ${response.status}`));
          return;
        }
        if (response.status === 429) {
          retryWait = retryAfterMs(response.headers.get("retry-after"));
        }
        options.onFlushError?.(new Error(`ingest answered ${response.status}, will retry`));
      } catch {
        options.onFlushError?.(new Error("ingest request failed, will retry"));
      } finally {
        clearTimeout(abort);
      }

      if (attempt >= maxAttempts) {
        drop(batch[0].kind, batch.length, "rejected");
        return;
      }
      const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
      const jittered = Math.random() * backoff;
      await sleep(retryWait ?? jittered);
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        while (buffer.length > 0) {
          const batch = buffer.slice(0, batchSize);
          buffer = buffer.slice(batch.length);
          await sendBatch(batch);
        }
      } finally {
        flushing = undefined;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      }
    })();
    return flushing;
  }

  return {
    record(metric) {
      enqueue({ kind: "metric", payload: metric });
    },
    emit(event) {
      enqueue({ kind: "event", payload: event });
    },
    receipt(receipt) {
      enqueue({ kind: "receipt", payload: receipt });
    },
    flush,
    async close(deadlineMs = 5000) {
      closed = true;
      const drained = flush();
      let expired = false;
      const deadline = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          expired = true;
          resolve();
        }, deadlineMs);
        unrefTimer(t);
      });
      await Promise.race([drained, deadline]);
      if (expired && buffer.length > 0) {
        const remaining = buffer;
        buffer = [];
        const counts = new Map<SinkItem["kind"], number>();
        for (const item of remaining) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
        for (const [kind, count] of counts) drop(kind, count, "shutdown-deadline");
      }
    },
  };
}
