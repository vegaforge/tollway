/**
 * @tollway/observability
 *
 * Spend, latency, and failure metrics per agent, per service, and per model,
 * with machine-readable exports and webhooks for whatever you want to wire
 * up. See docs/design.md, "Observability".
 */

import { NotImplementedError, type SettlementModel } from "@tollway/core";

/** Webhook event names, matching docs/design.md, "Observability". */
export const webhookEvents = [
  "receipt.created",
  "channel.opened",
  "channel.closed",
  "budget.warning",
  "anomaly.detected",
] as const;

export type WebhookEvent = (typeof webhookEvents)[number];

export type TollwayEvent = {
  type: WebhookEvent;
  /** ISO 8601 timestamp. */
  at: string;
  /** Event-specific fields; shape depends on the event type. */
  data: Record<string, unknown>;
};

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

export type SpendSummary = {
  totalAmount: string;
  count: number;
  byModel: Partial<Record<SettlementModel, string>>;
};

export type ExportFormat = "json" | "csv";

export type WebhookHandler = (event: TollwayEvent) => void | Promise<void>;

/**
 * A subscription to one or more webhook events delivered via HTTP POST. An
 * `events` list of `undefined` (or empty) means "all events"; otherwise only
 * the listed event types are POSTed to `url`.
 */
export type WebhookSubscription = {
  url: string;
  events?: WebhookEvent[];
  /** Additional headers to merge into the request. */
  headers?: Record<string, string>;
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
};

export interface ObservabilityHub {
  /** Collect a payment metric for rollups. Implementation tracked in #31. */
  record(metric: PaymentMetric): void;
  /**
   * Dispatch an event to every registered handler and matching webhook URL.
   * Resolves with a {@link DeliveryReport} describing which targets succeeded
   * and which exhausted their retry budget; the promise itself does not
   * reject so callers can record full delivery telemetry rather than the
   * first failure that bubbles up.
   */
  emit(event: TollwayEvent): Promise<DeliveryReport>;
  /** Register a local handler invoked synchronously during {@link emit}. */
  on(event: WebhookEvent, handler: WebhookHandler): void;
  /** Register an HTTP webhook subscription after construction. */
  addWebhook(subscription: WebhookSubscription): void;
  /** Roll payment metrics into a spend summary. Implementation tracked in #31. */
  summarize(query?: MetricsQuery): SpendSummary;
  /** Serialize matching metrics as JSON or CSV. Implementation tracked in #31. */
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
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  let response: Response;
  try {
    response = await fetcher(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(subscription.headers ?? {}),
      },
      body: JSON.stringify(event),
      signal: controller?.signal,
    });
  } catch (cause) {
    if (controller?.signal.aborted) {
      throw new Error(`webhook ${subscription.url} timed out after ${timeoutMs}ms`);
    }
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `webhook ${subscription.url} responded with ${response.status} ${response.statusText}`.trim(),
    );
  }
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
 * Metric collection (`record`, `summarize`, `export`) is the scope of #31 and
 * currently throws `NotImplementedError` from those methods.
 */
export function createObservabilityHub(options: ObservabilityHubOptions = {}): ObservabilityHub {
  const handlers = new Map<WebhookEvent, WebhookHandler[]>();
  const subscriptions: WebhookSubscription[] = [];

  if (options.webhooks) {
    for (const sub of options.webhooks) {
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

  function notImplemented(feature: string): never {
    throw new NotImplementedError(feature, 'docs/design.md, "Observability" (#31)');
  }

  return {
    record() {
      notImplemented("metric recording");
    },
    summarize() {
      notImplemented("spend summarization");
    },
    export() {
      notImplemented("metrics export");
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
      subscriptions.push({
        ...subscription,
        events: subscription.events ? [...subscription.events] : undefined,
      });
    },
    async emit(event) {
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
