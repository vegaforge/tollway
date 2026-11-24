/**
 * @vegaforge/tollway-observability
 *
 * Spend, latency, and failure metrics per agent, per service, and per model,
 * with machine-readable exports and webhooks for whatever you want to wire
 * up. See docs/design.md, "Observability".
 */

import type { SponsorBalanceReading } from "@vegaforge/tollway-core";
import { TollwayError } from "@vegaforge/tollway-core";
import { createWebhookDispatcher, type WebhookDispatcherTuning } from "./dispatcher.js";
import type { TollwayEvent, TollwayEventInput, WebhookEvent } from "./events.js";
import type { MetricsQuery, PaymentMetric, SpendSummary } from "./metrics.js";
import {
  assertValidMetric,
  closedStoreError,
  copyMetric,
  decodeCursor,
  encodeCursor,
  type MetricsPage,
  type MetricsPageRequest,
  type MetricsStore,
  resolvePageLimit,
} from "./metrics-store.js";
import type { WebhookOutbox } from "./outbox.js";
import { summarizeMetrics } from "./summary.js";
import {
  assertTimeseriesLimits,
  computeTimeseries,
  DEFAULT_MAX_TIMESERIES_BUCKETS,
  DEFAULT_MAX_TIMESERIES_ROWS,
  type TimeseriesQuery,
  type TimeseriesResult,
} from "./timeseries.js";
import { assertWebhookSecret, buildWebhookRequest, postWebhook } from "./webhook-http.js";

export {
  createWebhookDispatcher,
  type WebhookDispatcher,
  type WebhookDispatcherOptions,
  type WebhookDispatcherTuning,
  WebhookLeaseLostError,
} from "./dispatcher.js";
export {
  isWebhookEvent,
  type TollwayEvent,
  type TollwayEventInput,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  type WebhookEvent,
  webhookEvents,
} from "./events.js";
export { createMemoryMetricsStore } from "./memory-metrics-store.js";
export type {
  MetricsQuery,
  ModelAssetSpend,
  PayeeAssetSpend,
  PayerAssetSpend,
  PaymentMetric,
  SpendOutcomeCounts,
  SpendSummary,
} from "./metrics.js";
export {
  assertValidMetric,
  DEFAULT_METRICS_PAGE_LIMIT,
  InvalidMetricError,
  MAX_METRICS_PAGE_LIMIT,
  type MetricsPage,
  type MetricsPageRequest,
  type MetricsStore,
} from "./metrics-store.js";
export {
  createMemoryWebhookOutbox,
  createSqliteWebhookOutbox,
  type NewWebhookDelivery,
  type SqliteWebhookOutbox,
  type SqliteWebhookOutboxOptions,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookLease,
  type WebhookOutbox,
} from "./outbox.js";
export {
  createPostgresMetricsStore,
  migratePostgresMetricsStore,
  POSTGRES_INSERT_CHUNK,
  type PostgresLikeClient,
  type PostgresMetricsStoreOptions,
} from "./postgres-metrics-store.js";
export {
  createPrometheusExporter,
  DEFAULT_LATENCY_BUCKETS_SECONDS,
  type PrometheusExporter,
  type PrometheusExporterOptions,
  type PrometheusRequest,
  type PrometheusResponse,
} from "./prometheus.js";
export { renderFeeSponsorMetrics, type SponsorReadingSource } from "./sponsor.js";
export {
  DEFAULT_MAX_TIMESERIES_BUCKETS,
  DEFAULT_MAX_TIMESERIES_ROWS,
  type LatencyPercentiles,
  MetricsQueryTooLargeError,
  nearestRankPercentile,
  parseIsoTimestamp,
  type TimeseriesBucket,
  type TimeseriesBucketResult,
  type TimeseriesGroupBy,
  type TimeseriesQuery,
  type TimeseriesResult,
  type TimeseriesRow,
  timeseriesBuckets,
} from "./timeseries.js";
export {
  type SignatureFailureReason,
  type SignatureVerification,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-signature.js";

export type ExportFormat = "json" | "csv";

export type WebhookHandler = (event: TollwayEvent) => void | Promise<void>;

/**
 * A subscription to one or more webhook events delivered via HTTP POST. An
 * `events` list of `undefined` (or empty) means "all events"; otherwise only
 * the listed event types are POSTed to `url`.
 */
export type WebhookSubscription = {
  /**
   * Stable id stored on outbox rows. Defaults to `url`, so give an explicit
   * id when the same URL is subscribed more than once.
   */
  id?: string;
  url: string;
  events?: WebhookEvent[];
  /** Additional headers to merge into the request. */
  headers?: Record<string, string>;
  /**
   * When set, every attempt carries a `Tollway-Signature` header over the
   * exact body sent. The secret stays in memory and is never written to an
   * outbox row. An empty string is refused: omit the field to send unsigned.
   */
  secret?: string;
};

/** Retry policy applied per target (handler or webhook URL). */
export type RetryPolicy = {
  /** Total attempts including the first. Must be >= 1. */
  maxAttempts: number;
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Delay multiplier between successive retries (exponential backoff). */
  backoffFactor: number;
};

/** Describes a single delivery target that exhausted its retry budget. */
export type DeliveryFailure = {
  target: { kind: "handler"; index: number } | { kind: "webhook"; url: string };
  event: TollwayEvent;
  error: Error;
  attempts: number;
};

/** Outcome of a single `emit` call. */
export type DeliveryReport = {
  event: TollwayEvent;
  handlersDispatched: number;
  webhooksDispatched: number;
  failures: DeliveryFailure[];
};

export type ObservabilityHubOptions = {
  /** Webhook URL subscriptions registered at construction time. */
  webhooks?: WebhookSubscription[];
  /** Override the default retry policy (3 attempts, 100ms / 2x backoff). */
  retry?: Partial<RetryPolicy>;
  /** Inject a custom fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-attempt webhook request timeout in milliseconds. When the underlying
   * `fetch` does not resolve within this window, the request is aborted via
   * `AbortController` and the failure is fed back into the retry pipeline like
   * any other delivery error. Defaults to 5000ms. Set to `0` to disable.
   */
  requestTimeoutMs?: number;
  /**
   * Invoked once per delivery target that exhausts its retry budget. Useful
   * for surfacing failures to an alerting pipeline without inspecting every
   * `DeliveryReport`.
   */
  onDeliveryFailure?: (failure: DeliveryFailure) => void;
  /**
   * Sleep function used between retries. Defaults to a real `setTimeout`;
   * tests inject a no-op to keep the timeline synchronous.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Most buckets one `timeseries` query may produce before it is rejected
   * with `MetricsQueryTooLargeError`. Defaults to 10080 (seven days of
   * one-minute buckets).
   */
  maxTimeseriesBuckets?: number;
  /**
   * Most rows (buckets times groups) one `timeseries` query may produce
   * before it is rejected with `MetricsQueryTooLargeError`. Defaults to
   * 200000.
   */
  maxTimeseriesRows?: number;
  /**
   * When set, `emit` persists one delivery row per matching webhook instead
   * of POSTing inline, and deliveries need a dispatcher
   * ({@link ObservabilityHub.startDispatcher}). Local handlers keep the
   * inline behaviour either way. With an outbox, `requestTimeoutMs` must be
   * at least 1 and shorter than the dispatcher's `leaseMs`.
   */
  outbox?: WebhookOutbox;
  /**
   * Outbox dispatcher settings; ignored without an `outbox`. The outbox does
   * not inherit `retry`: that policy is sized for retries inside one `emit`
   * call, and the dispatcher's defaults are sized for an outage (see
   * {@link WebhookDispatcherTuning}).
   */
  dispatcher?: Partial<WebhookDispatcherTuning>;
  /**
   * Durable storage for payment metrics (#217). Without one, metrics stay in
   * an in-memory array exactly as before. With one, `record` validates each
   * metric and buffers it, and the buffer is written to the store in
   * batches. Read stored metrics back with `queryMetrics`,
   * `summarizeAsync` and `exportAsync`; the synchronous `summarize`,
   * `timeseries` and `export` throw, because a store cannot answer
   * synchronously.
   */
  store?: MetricsStore;
  /**
   * Called with every batch the store failed to write, and the error.
   * Required with a `store`, so a write failure is never silently dropped.
   * The hub does not retry the batch.
   */
  onStoreError?: (error: Error, metrics: readonly PaymentMetric[]) => void;
  /** How the hub batches writes to the store. Ignored without a `store`. */
  storeBuffer?: Partial<MetricsBufferTuning>;
};

export type MetricsBufferTuning = {
  /** Metrics per write. A full buffer is flushed at once. Default 100, at most 1000. */
  maxBatchSize: number;
  /** How often a partly full buffer is flushed. Default 1000ms. */
  flushIntervalMs: number;
};

/** What a webhook or handler delivery came to, for exporters. */
export type DeliveryOutcome = {
  result: "delivered" | "failed";
  targetKind: "handler" | "webhook";
};

/**
 * Receives every metric the hub records and every delivery outcome, as they
 * happen. Exporters keep counters this way, so the counters do not depend
 * on how much history a store keeps.
 */
export type HubObserver = {
  onMetric?: (metric: PaymentMetric) => void;
  onDelivery?: (outcome: DeliveryOutcome) => void;
};

export interface ObservabilityHub {
  /** Store the latest attempt for this (network, account), replacing any previous value. */
  recordSponsorBalance(reading: SponsorBalanceReading): void;
  /** Copies of the latest sponsor readings, including stale/error status. */
  getSponsorReadings(): SponsorBalanceReading[];
  /** Collect a payment metric for rollups. Implementation tracked in #31. */
  record(metric: PaymentMetric): void;
  /**
   * Dispatch an event to every registered handler and matching webhook URL.
   * Resolves with a {@link DeliveryReport} describing which targets succeeded
   * and which exhausted their retry budget; the promise itself does not
   * reject so callers can record full delivery telemetry rather than the
   * first failure that bubbles up. With an outbox, a webhook delivery that
   * could not be written to it (for example `database is locked` after the
   * SQLite busy timeout) is listed in `failures` with `attempts: 0` instead
   * of rejecting. The hub assigns the event id when the input does not carry
   * one.
   */
  emit(event: TollwayEventInput): Promise<DeliveryReport>;
  /** Register a local handler invoked synchronously during {@link ObservabilityHub.emit}. */
  on(event: WebhookEvent, handler: WebhookHandler): void;
  /** Register an HTTP webhook subscription after construction. */
  addWebhook(subscription: WebhookSubscription): void;
  /**
   * Starts delivering outbox rows on a timer. Throws when the hub was built
   * without an `outbox`.
   */
  startDispatcher(): void;
  /**
   * Stops the dispatcher and waits for in-flight deliveries, up to the
   * configured `stopTimeoutMs`. A no-op when the dispatcher was not started.
   */
  stop(): Promise<void>;
  /** Roll payment metrics into a spend summary. Implementation tracked in #31. */
  summarize(query?: MetricsQuery): SpendSummary;
  /**
   * Bucket matching metrics by time and return, per bucket, one row per
   * model and asset (and payee or payer when `groupBy` asks): the settled
   * amount, settled / failed / skipped counts, and nearest-rank latency
   * percentiles. The range is `[from, to)` and every bucket in it is
   * returned, empty ones included. Throws a `TollwayError` with code
   * `invalid-metrics-query` for a malformed query, `invalid-metric` for a
   * recorded metric that cannot be bucketed or summed, and
   * `MetricsQueryTooLargeError` when the result would exceed the hub's
   * limits.
   */
  timeseries(query: TimeseriesQuery): TimeseriesResult;
  /**
   * Serialize matching metrics as JSON or RFC 4180 CSV. CSV cells starting
   * with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with a
   * single quote to prevent spreadsheet formula injection, so those cells do
   * not read back byte for byte. JSON output is never altered.
   */
  export(format: ExportFormat, query?: MetricsQuery): string;
  /**
   * Matching metrics, one page at a time, in recording order. Reads the
   * store when there is one, otherwise the in-memory metrics. Metrics still
   * in the write buffer are not included: call {@link ObservabilityHub.flush} first.
   */
  queryMetrics(query?: MetricsQuery, page?: MetricsPageRequest): Promise<MetricsPage>;
  /** {@link ObservabilityHub.summarize}, answered by the store when there is one. */
  summarizeAsync(query?: MetricsQuery): Promise<SpendSummary>;
  /** {@link ObservabilityHub.export}, read from the store when there is one. */
  exportAsync(format: ExportFormat, query?: MetricsQuery): Promise<string>;
  /**
   * Writes every buffered metric to the store and waits for the writes. A
   * failed batch goes to `onStoreError`; `flush` itself does not reject.
   * Resolves at once without a store.
   */
  flush(): Promise<void>;
  /**
   * Flushes the buffer, stops the flush timer and closes the store. Later
   * calls to `record` throw. Does not stop the webhook dispatcher: call
   * {@link ObservabilityHub.stop} for that.
   */
  close(): Promise<void>;
  /** Adds an observer. Returns a function that removes it. */
  observe(observer: HubObserver): () => void;
}

const DEFAULT_BUFFER: MetricsBufferTuning = { maxBatchSize: 100, flushIntervalMs: 1000 };

function resolveBuffer(tuning: Partial<MetricsBufferTuning> | undefined): MetricsBufferTuning {
  const buffer = { ...DEFAULT_BUFFER, ...tuning };
  if (
    !Number.isSafeInteger(buffer.maxBatchSize) ||
    buffer.maxBatchSize < 1 ||
    buffer.maxBatchSize > 1000
  ) {
    throw new RangeError(
      `storeBuffer.maxBatchSize must be a whole number from 1 to 1000, got ${buffer.maxBatchSize}`,
    );
  }
  if (!Number.isSafeInteger(buffer.flushIntervalMs) || buffer.flushIntervalMs < 1) {
    throw new RangeError(
      `storeBuffer.flushIntervalMs must be a whole number of at least 1, got ${buffer.flushIntervalMs}`,
    );
  }
  return buffer;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  backoffFactor: 2,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

function matchesQuery(m: PaymentMetric, query?: MetricsQuery): boolean {
  if (!query) return true;
  if (query.payer !== undefined && m.payer !== query.payer) return false;
  if (query.payee !== undefined && m.payee !== query.payee) return false;
  if (query.model !== undefined && m.model !== query.model) return false;
  if (query.asset !== undefined && m.asset !== query.asset) return false;
  if (query.outcome !== undefined && m.outcome !== query.outcome) return false;
  // `at` is ISO 8601; string comparison is order-preserving for that grammar.
  if (query.from !== undefined && m.at < query.from) return false;
  if (query.to !== undefined && m.at > query.to) return false;
  return true;
}

function filterMetrics(metrics: PaymentMetric[], query?: MetricsQuery): PaymentMetric[] {
  return metrics.filter((m) => matchesQuery(m, query));
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * RFC 4180 escaping with spreadsheet formula-injection neutralization: cells
 * starting with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with a single quote before
 * wrapping in double quotes and doubling embedded double quotes.
 */
function csvEscape(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = [
  "payer",
  "payee",
  "model",
  "amount",
  "asset",
  "latencyMs",
  "outcome",
  "at",
] as const;

function toCsv(metrics: PaymentMetric[]): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const m of metrics) {
    lines.push(
      [
        csvEscape(m.payer),
        csvEscape(m.payee),
        csvEscape(m.model),
        csvEscape(m.amount),
        csvEscape(m.asset),
        m.latencyMs.toString(),
        csvEscape(m.outcome),
        csvEscape(m.at),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}

function subscriptionMatches(subscription: WebhookSubscription, event: WebhookEvent): boolean {
  if (!subscription.events || subscription.events.length === 0) return true;
  return subscription.events.includes(event);
}

async function withRetry<T>(
  attempt: () => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void>,
): Promise<
  { ok: true; value: T; attempts: number } | { ok: false; error: Error; attempts: number }
> {
  let lastError: Error | null = null;
  let delay = policy.initialDelayMs;
  const maxAttempts = Math.max(1, policy.maxAttempts);

  for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
    try {
      const value = await attempt();
      return { ok: true, value, attempts: attemptIndex };
    } catch (cause) {
      lastError = normalizeError(cause);
      if (attemptIndex >= maxAttempts) break;
      if (delay > 0) await sleep(delay);
      delay = Math.round(delay * policy.backoffFactor);
    }
  }

  return {
    ok: false,
    error: lastError ?? new Error("delivery failed without a captured cause"),
    attempts: maxAttempts,
  };
}

async function deliverWebhook(
  fetcher: typeof globalThis.fetch,
  subscription: WebhookSubscription,
  event: TollwayEvent,
  timeoutMs: number,
): Promise<void> {
  const request = await buildWebhookRequest({ subscription, event });
  await postWebhook({ fetcher, url: subscription.url, request, timeoutMs });
}

function subscriptionKey(subscription: WebhookSubscription): string {
  return subscription.id ?? subscription.url;
}

/**
 * Build an `ObservabilityHub` wired for webhook dispatch. Local handlers
 * registered via {@link ObservabilityHub.on} and HTTP subscriptions registered
 * via {@link ObservabilityHub.addWebhook} (or the `webhooks` constructor
 * option) both receive every matching {@link TollwayEvent}. Each webhook
 * request is bounded by `requestTimeoutMs` (default 5s) via `AbortController`
 * so a stalled subscriber socket cannot hang `emit`; a timeout is treated
 * exactly like any other delivery failure. Delivery failures are retried per
 * the configured {@link RetryPolicy}; surviving failures are surfaced via the
 * returned {@link DeliveryReport} and the optional `onDeliveryFailure`
 * callback rather than being swallowed.
 *
 * With an `outbox`, webhook deliveries are persisted instead: `emit` writes
 * one row per matching subscription and resolves, and
 * {@link ObservabilityHub.startDispatcher} delivers rows with backoff across
 * restarts. The secret is resolved from the in-memory subscription at send
 * time, so it is signed fresh on every attempt and never persisted.
 *
 * Metric collection (`record`, `summarize`, `timeseries`, `export`) keeps an in-memory
 * array of `PaymentMetric` values. The hub holds the rollup primitives a
 * service-side dashboard or exporter actually consumes; the storage is
 * deliberately ephemeral so production deployments can swap it for a
 * persistent backend through the same interface (the optional shared
 * service in `docs/design.md`, "Architecture").
 */
export function createObservabilityHub(options: ObservabilityHubOptions = {}): ObservabilityHub {
  const handlers = new Map<WebhookEvent, WebhookHandler[]>();
  const subscriptions: WebhookSubscription[] = [];
  const metrics: PaymentMetric[] = [];
  const sponsors = new Map<string, SponsorBalanceReading>();

  if (options.webhooks) {
    for (const sub of options.webhooks) {
      assertWebhookSecret(sub.secret);
      subscriptions.push({ ...sub, events: sub.events ? [...sub.events] : undefined });
    }
  }

  const retry: RetryPolicy = {
    ...DEFAULT_RETRY,
    ...(options.retry ?? {}),
  };
  const fetcher = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? realSleep;
  const onDeliveryFailure = options.onDeliveryFailure;
  const requestTimeoutMs =
    options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const timeseriesLimits = {
    maxBuckets: options.maxTimeseriesBuckets ?? DEFAULT_MAX_TIMESERIES_BUCKETS,
    maxRows: options.maxTimeseriesRows ?? DEFAULT_MAX_TIMESERIES_ROWS,
  };
  // Checked here so a bad limit fails at startup, not on the first query.
  assertTimeseriesLimits(timeseriesLimits);

  const observers = new Set<HubObserver>();
  const notifyMetric = (metric: PaymentMetric) => {
    for (const observer of observers) observer.onMetric?.(metric);
  };
  const notifyDelivery = (outcome: DeliveryOutcome) => {
    for (const observer of observers) observer.onDelivery?.(outcome);
  };

  const store = options.store;
  const onStoreError = options.onStoreError;
  if (store && !onStoreError) {
    throw new TypeError(
      "a metrics store needs onStoreError, so a failed write is reported instead of lost",
    );
  }
  const buffer = resolveBuffer(options.storeBuffer);
  let pending: PaymentMetric[] = [];
  let writing: Promise<void> = Promise.resolve();
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let storeClosed = false;

  /** Hands the buffer to the store. Writes run one after another, in order. */
  function flushBuffer(): Promise<void> {
    if (!store || pending.length === 0) return writing;
    const batch = pending;
    pending = [];
    writing = writing.then(async () => {
      try {
        await store.append(batch);
      } catch (cause) {
        onStoreError?.(normalizeError(cause), batch);
      }
    });
    return writing;
  }

  function ensureFlushTimer(): void {
    if (flushTimer !== null) return;
    flushTimer = setInterval(() => {
      void flushBuffer();
    }, buffer.flushIntervalMs);
    // A pending flush must not keep a finished process alive; close() drains it.
    if (typeof flushTimer === "object" && "unref" in flushTimer) flushTimer.unref();
  }

  function requireNoStore(method: string, instead: string): void {
    if (store) {
      throw new TollwayError(
        "invalid-metrics-query",
        `${method} cannot read a metrics store synchronously; use ${instead}`,
      );
    }
  }

  const outbox = options.outbox;
  const dispatcher = outbox
    ? createWebhookDispatcher({
        ...options.dispatcher,
        outbox,
        resolveSubscription: (subscriptionId) =>
          subscriptions.find((sub) => subscriptionKey(sub) === subscriptionId),
        fetch: fetcher,
        requestTimeoutMs,
        onDelivered: () => notifyDelivery({ result: "delivered", targetKind: "webhook" }),
        onDeliveryFailure: (failure) => {
          notifyDelivery({ result: "failed", targetKind: "webhook" });
          onDeliveryFailure?.({
            // A row whose subscription is gone has no URL left; name it by
            // the subscription id so the failure is still identifiable.
            target: { kind: "webhook", url: failure.url ?? failure.subscriptionId },
            event: failure.delivery.event,
            error: failure.error,
            attempts: failure.attempts,
          });
        },
      })
    : null;

  return {
    recordSponsorBalance(reading) {
      sponsors.set(`${reading.network}:${reading.account}`, { ...reading });
    },
    getSponsorReadings() {
      return [...sponsors.values()].map((reading) => ({ ...reading }));
    },
    record(metric) {
      if (!store) {
        metrics.push({ ...metric });
        notifyMetric(metric);
        return;
      }
      if (storeClosed) throw closedStoreError();
      // A durable store refuses a malformed metric, so refuse it here, where
      // the caller can still see the error, rather than in a later batch.
      assertValidMetric(metric);
      pending.push(copyMetric(metric));
      notifyMetric(metric);
      if (pending.length >= buffer.maxBatchSize) {
        void flushBuffer();
      } else {
        ensureFlushTimer();
      }
    },
    async queryMetrics(query, page) {
      if (store) return store.query(query, page);
      const limit = resolvePageLimit(page);
      const after = decodeCursor(page?.cursor);
      // Positions are 1-based indexes into the in-memory array, like the
      // row positions a store uses.
      const found: PaymentMetric[] = [];
      for (let index = after; index < metrics.length; index += 1) {
        const metric = metrics[index] as PaymentMetric;
        if (!matchesQuery(metric, query)) continue;
        if (found.length === limit) {
          return { metrics: found, nextCursor: encodeCursor(index) };
        }
        found.push(copyMetric(metric));
      }
      const result: MetricsPage = { metrics: found };
      return result;
    },
    async summarizeAsync(query) {
      if (store) return store.summarize(query);
      return this.summarize(query);
    },
    async exportAsync(format, query) {
      if (!store) return this.export(format, query);
      if (format !== "json" && format !== "csv") {
        throw new Error(`unsupported export format: ${format as string}`);
      }
      const all: PaymentMetric[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query(query, cursor === undefined ? {} : { cursor });
        all.push(...page.metrics);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return format === "json" ? JSON.stringify(all) : toCsv(all);
    },
    async flush() {
      await flushBuffer();
    },
    async close() {
      if (storeClosed) return;
      storeClosed = true;
      if (flushTimer !== null) clearInterval(flushTimer);
      flushTimer = null;
      await flushBuffer();
      await store?.close();
    },
    observe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    summarize(query) {
      requireNoStore("summarize", "summarizeAsync");
      return summarizeMetrics(filterMetrics(metrics, query));
    },
    timeseries(query) {
      requireNoStore("timeseries", "queryMetrics");
      return computeTimeseries(metrics, query, timeseriesLimits);
    },
    export(format, query) {
      requireNoStore("export", "exportAsync");
      const matched = filterMetrics(metrics, query);
      if (format === "json") {
        return JSON.stringify(matched);
      }
      if (format === "csv") {
        return toCsv(matched);
      }
      // The ExportFormat type already restricts this at compile time; this
      // branch is the runtime guard for callers that crossed the boundary
      // with an unchecked string.
      throw new Error(`unsupported export format: ${format as string}`);
    },
    on(event, handler) {
      const existing = handlers.get(event);
      if (existing) {
        existing.push(handler);
      } else {
        handlers.set(event, [handler]);
      }
    },
    addWebhook(subscription) {
      assertWebhookSecret(subscription.secret);
      subscriptions.push({
        ...subscription,
        events: subscription.events ? [...subscription.events] : undefined,
      });
    },
    startDispatcher() {
      if (!dispatcher) {
        throw new Error("startDispatcher requires an outbox");
      }
      dispatcher.start();
    },
    async stop() {
      if (dispatcher) await dispatcher.stop();
    },
    async emit(input) {
      const event: TollwayEvent = {
        ...input,
        id: input.id ?? globalThis.crypto.randomUUID(),
      };
      const failures: DeliveryFailure[] = [];

      const matchingHandlers = handlers.get(event.type) ?? [];
      const handlerResults = await Promise.all(
        matchingHandlers.map((handler, index) =>
          withRetry(async () => handler(event), retry, sleep).then((result) => ({ result, index })),
        ),
      );

      for (const { result, index } of handlerResults) {
        notifyDelivery({ result: result.ok ? "delivered" : "failed", targetKind: "handler" });
        if (!result.ok) {
          const failure: DeliveryFailure = {
            target: { kind: "handler", index },
            event,
            error: result.error,
            attempts: result.attempts,
          };
          failures.push(failure);
          onDeliveryFailure?.(failure);
        }
      }

      const matchingSubs = subscriptions.filter((sub) => subscriptionMatches(sub, event.type));

      if (outbox) {
        const deliveries = matchingSubs.map((sub) => ({
          subscriptionId: subscriptionKey(sub),
          event,
        }));
        try {
          await outbox.enqueue(deliveries);
        } catch (cause) {
          // The rows were not written, so nothing will deliver them. Report
          // each one instead of rejecting: emit never rejects, and a caller
          // that does not await it would otherwise crash the process.
          const error = normalizeError(cause);
          for (const sub of matchingSubs) {
            notifyDelivery({ result: "failed", targetKind: "webhook" });
            const failure: DeliveryFailure = {
              target: { kind: "webhook", url: sub.url },
              event,
              error,
              attempts: 0,
            };
            failures.push(failure);
            onDeliveryFailure?.(failure);
          }
          return {
            event,
            handlersDispatched: matchingHandlers.length,
            webhooksDispatched: 0,
            failures,
          };
        }
        return {
          event,
          handlersDispatched: matchingHandlers.length,
          webhooksDispatched: deliveries.length,
          failures,
        };
      }

      if (!fetcher && matchingSubs.length > 0) {
        for (const sub of matchingSubs) {
          notifyDelivery({ result: "failed", targetKind: "webhook" });
          const failure: DeliveryFailure = {
            target: { kind: "webhook", url: sub.url },
            event,
            error: new Error(
              "no fetch implementation is available; pass options.fetch or run on Node 18+",
            ),
            attempts: 0,
          };
          failures.push(failure);
          onDeliveryFailure?.(failure);
        }

        return {
          event,
          handlersDispatched: matchingHandlers.length,
          webhooksDispatched: 0,
          failures,
        };
      }

      const activeFetcher = fetcher;
      const webhookResults = activeFetcher
        ? await Promise.all(
            matchingSubs.map((sub) =>
              withRetry(
                () => deliverWebhook(activeFetcher, sub, event, requestTimeoutMs),
                retry,
                sleep,
              ).then((result) => ({ result, url: sub.url })),
            ),
          )
        : [];

      for (const { result, url } of webhookResults) {
        notifyDelivery({ result: result.ok ? "delivered" : "failed", targetKind: "webhook" });
        if (!result.ok) {
          const failure: DeliveryFailure = {
            target: { kind: "webhook", url },
            event,
            error: result.error,
            attempts: result.attempts,
          };
          failures.push(failure);
          onDeliveryFailure?.(failure);
        }
      }

      return {
        event,
        handlersDispatched: matchingHandlers.length,
        webhooksDispatched: matchingSubs.length,
        failures,
      };
    },
  };
}

export {
  type AppendOutcome,
  type ArchiveSearchOptions,
  type ArchiveSearchResult,
  createMemoryReceiptArchive,
  DEFAULT_ARCHIVE_PAGE_SIZE,
  MAX_ARCHIVE_PAGE_SIZE,
  type ReceiptArchive,
  type ReceiptArchiveOptions,
  type ReceiptFilter,
} from "./receipt-archive.js";
export {
  createSqliteReceiptArchive,
  type SqliteReceiptArchive,
  type SqliteReceiptArchiveOptions,
} from "./receipt-archive-sqlite.js";
