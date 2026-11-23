/**
 * @vegaforge/tollway-observability
 *
 * Spend, latency, and failure metrics per agent, per service, and per model,
 * with machine-readable exports and webhooks for whatever you want to wire
 * up. See docs/design.md, "Observability".
 */

import type { SettlementModel } from "@vegaforge/tollway-core";
import { createWebhookDispatcher, type WebhookDispatcherTuning } from "./dispatcher.js";
import type { TollwayEvent, TollwayEventInput, WebhookEvent } from "./events.js";
import type { WebhookOutbox } from "./outbox.js";
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

/** A single measured payment, the unit metrics roll up from. */
export type PaymentMetric = {
  payer: string;
  payee: string;
  model: SettlementModel;
  amount: string;
  asset: string;
  latencyMs: number;
  outcome: "settled" | "failed" | "skipped";
  at: string;
};

export type MetricsQuery = {
  payer?: string;
  payee?: string;
  model?: SettlementModel;
  /** Inclusive ISO 8601 bounds. */
  from?: string;
  to?: string;
};

/**
 * Aggregated spend over a query window. Amounts are integer strings in the
 * asset's smallest unit (same convention as `PaymentMetric.amount` and the
 * canonical receipt). Every amount field counts metrics of every outcome
 * (settled, failed and skipped); `count` is the number of matched metrics.
 * Keys for `byPayer` / `byPayee` are the payer / payee addresses exactly as
 * they appear on the recorded metrics. For settled-only amounts, an outcome
 * split and latency, use `ObservabilityHub.timeseries`.
 */
export type SpendSummary = {
  /**
   * @deprecated Adds amounts across assets, so it is only meaningful when the
   * window holds a single asset. Use `byAsset`.
   */
  totalAmount: string;
  count: number;
  /**
   * Amount per asset, keyed by `PaymentMetric.asset`. Amounts in different
   * assets are never added together.
   */
  byAsset: Record<string, string>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries`, whose rows are
   * keyed by model and asset.
   */
  byModel: Partial<Record<SettlementModel, string>>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries` with
   * `groupBy: "payer"`.
   */
  byPayer: Record<string, string>;
  /**
   * @deprecated Adds amounts across assets. Use `timeseries` with
   * `groupBy: "payee"`.
   */
  byPayee: Record<string, string>;
};

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
};

export interface ObservabilityHub {
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
  /** Register a local handler invoked synchronously during {@link emit}. */
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

function filterMetrics(metrics: PaymentMetric[], query?: MetricsQuery): PaymentMetric[] {
  if (!query) return metrics.slice();
  return metrics.filter((m) => {
    if (query.payer !== undefined && m.payer !== query.payer) return false;
    if (query.payee !== undefined && m.payee !== query.payee) return false;
    if (query.model !== undefined && m.model !== query.model) return false;
    // `at` is ISO 8601; string comparison is order-preserving for that grammar.
    if (query.from !== undefined && m.at < query.from) return false;
    if (query.to !== undefined && m.at > query.to) return false;
    return true;
  });
}

function stringifyBigintMap<K extends string>(
  source: Partial<Record<K, bigint>> | Record<K, bigint>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const [key, value] of Object.entries(source) as Array<[K, bigint | undefined]>) {
    if (value !== undefined) {
      out[key] = value.toString();
    }
  }
  return out;
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

  const outbox = options.outbox;
  const dispatcher = outbox
    ? createWebhookDispatcher({
        ...options.dispatcher,
        outbox,
        resolveSubscription: (subscriptionId) =>
          subscriptions.find((sub) => subscriptionKey(sub) === subscriptionId),
        fetch: fetcher,
        requestTimeoutMs,
        onDeliveryFailure: (failure) => {
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
    record(metric) {
      metrics.push({ ...metric });
    },
    summarize(query) {
      const matched = filterMetrics(metrics, query);
      let totalAmount = 0n;
      const byAsset: Record<string, bigint> = {};
      const byModel: Partial<Record<SettlementModel, bigint>> = {};
      const byPayer: Record<string, bigint> = {};
      const byPayee: Record<string, bigint> = {};

      for (const m of matched) {
        let amount: bigint;
        try {
          amount = BigInt(m.amount);
        } catch {
          // A non-integer amount cannot be summed safely; skip it rather
          // than poison the rollups for the whole window. The metric is
          // still visible via export().
          continue;
        }
        totalAmount += amount;
        byAsset[m.asset] = (byAsset[m.asset] ?? 0n) + amount;
        byModel[m.model] = (byModel[m.model] ?? 0n) + amount;
        byPayer[m.payer] = (byPayer[m.payer] ?? 0n) + amount;
        byPayee[m.payee] = (byPayee[m.payee] ?? 0n) + amount;
      }

      return {
        totalAmount: totalAmount.toString(),
        count: matched.length,
        byAsset: stringifyBigintMap(byAsset),
        byModel: stringifyBigintMap(byModel) as Partial<Record<SettlementModel, string>>,
        byPayer: stringifyBigintMap(byPayer),
        byPayee: stringifyBigintMap(byPayee),
      };
    },
    timeseries(query) {
      return computeTimeseries(metrics, query, timeseriesLimits);
    },
    export(format, query) {
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
