/**
 * Claims due webhook deliveries from an outbox and POSTs them, with a lease so
 * two dispatchers sharing one store never deliver the same row concurrently,
 * jittered exponential backoff between attempts, and a dead-letter state once
 * `maxAttempts` is spent.
 *
 * Timers are unref'd, so a running dispatcher never keeps a Node process
 * alive by itself. See docs/webhook-delivery.md.
 */

import type { WebhookSubscription } from "./index.js";
import type { WebhookDelivery, WebhookOutbox } from "./outbox.js";
import { buildWebhookRequest, postWebhook } from "./webhook-http.js";

/** Knobs a hub passes through; tests set them to keep time deterministic. */
export type WebhookDispatcherTuning = {
  /** Attempts per delivery before dead-lettering. Defaults to 3. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 100ms. */
  initialDelayMs?: number;
  /** Multiplier between attempts. Defaults to 2. */
  backoffFactor?: number;
  /** Upper bound on one backoff delay. Defaults to 60000ms. */
  maxDelayMs?: number;
  /** Rows claimed per pass. Defaults to 20. */
  batchSize?: number;
  /** How long a claimed row stays leased. Defaults to 30000ms. */
  leaseMs?: number;
  /** Idle time between passes. Defaults to 1000ms. */
  intervalMs?: number;
  /** How long `stop()` waits for in-flight deliveries. Defaults to 5000ms. */
  stopTimeoutMs?: number;
  /** Jitter source in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
};

export type WebhookDispatcherOptions = WebhookDispatcherTuning & {
  outbox: WebhookOutbox;
  /** Resolves the subscription a row was enqueued for, including its secret. */
  resolveSubscription: (subscriptionId: string) => WebhookSubscription | undefined;
  fetch: typeof globalThis.fetch;
  /** Per-attempt request timeout. `0` disables it. */
  requestTimeoutMs: number;
  /** Called when a delivery exhausts its attempts or its subscription is gone. */
  onDeliveryFailure?: (failure: {
    /** Present when the subscription is still registered. */
    url?: string;
    subscriptionId: string;
    delivery: WebhookDelivery;
    error: Error;
    attempts: number;
  }) => void;
  /** Called when a pass fails, for example because the store rejected a claim. */
  onError?: (error: Error) => void;
};

export type WebhookDispatcher = {
  /** Starts the timer loop. Calling it twice is a no-op. */
  start(): void;
  /**
   * Stops scheduling passes and waits for in-flight deliveries up to
   * `stopTimeoutMs`. Rows still leased after that are released so another
   * dispatcher can retry them.
   */
  stop(): Promise<void>;
  /** Runs one claim-and-deliver pass. Returns the number of rows handled. */
  drainOnce(): Promise<number>;
};

const DEFAULTS = {
  maxAttempts: 3,
  initialDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 60_000,
  batchSize: 20,
  leaseMs: 30_000,
  intervalMs: 1_000,
  stopTimeoutMs: 5_000,
} as const;

function assertOption(value: number, name: string, minimum: number, integer: boolean): void {
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new RangeError(
      `${name} must be ${integer ? "an integer" : "a number"} of at least ${minimum}`,
    );
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const initialDelayMs = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const backoffFactor = options.backoffFactor ?? DEFAULTS.backoffFactor;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  assertOption(maxAttempts, "maxAttempts", 1, true);
  assertOption(initialDelayMs, "initialDelayMs", 0, true);
  assertOption(backoffFactor, "backoffFactor", 1, false);
  assertOption(maxDelayMs, "maxDelayMs", 0, true);
  assertOption(batchSize, "batchSize", 1, true);
  assertOption(leaseMs, "leaseMs", 1, true);
  assertOption(intervalMs, "intervalMs", 0, true);
  assertOption(stopTimeoutMs, "stopTimeoutMs", 0, true);

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Map<string, Promise<void>>();
  const passes = new Set<Promise<number>>();

  /**
   * Equal jitter: half the capped delay is fixed, the other half is random,
   * so retries of one outage do not arrive together. `attempt` is the number
   * of the attempt that just failed, starting at 1.
   */
  function backoffDelay(attempt: number): number {
    const capped = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** (attempt - 1));
    const jittered = capped / 2 + random() * (capped / 2);
    return Math.round(jittered);
  }

  function report(
    delivery: WebhookDelivery,
    url: string | undefined,
    error: Error,
    attempts: number,
  ): void {
    options.onDeliveryFailure?.({
      url,
      subscriptionId: delivery.subscriptionId,
      delivery,
      error,
      attempts,
    });
  }

  async function deliver(delivery: WebhookDelivery): Promise<void> {
    const subscription = options.resolveSubscription(delivery.subscriptionId);
    if (!subscription) {
      const error = new Error(
        `webhook subscription ${delivery.subscriptionId} is no longer registered`,
      );
      await options.outbox.deadLetter(delivery.id, error.message);
      report(delivery, undefined, error, delivery.attempts);
      return;
    }

    try {
      const request = await buildWebhookRequest({
        subscription,
        event: delivery.event,
        deliveryId: delivery.id,
      });
      await postWebhook({
        fetcher: options.fetch,
        url: subscription.url,
        request,
        timeoutMs: options.requestTimeoutMs,
      });
      await options.outbox.markDelivered(delivery.id);
    } catch (cause) {
      const error = toError(cause);
      const attempts = delivery.attempts + 1;
      if (attempts >= maxAttempts) {
        await options.outbox.deadLetter(delivery.id, error.message);
        report(delivery, subscription.url, error, attempts);
      } else {
        await options.outbox.markFailed(delivery.id, now() + backoffDelay(attempts), error.message);
      }
    }
  }

  async function drainPass(): Promise<number> {
    const claimed = await options.outbox.claim(batchSize, leaseMs, now());
    await Promise.all(
      claimed.map((delivery) => {
        const work = deliver(delivery).finally(() => {
          inFlight.delete(delivery.id);
        });
        inFlight.set(delivery.id, work);
        return work;
      }),
    );
    return claimed.length;
  }

  function drainOnce(): Promise<number> {
    const pass = drainPass();
    passes.add(pass);
    // Clean up on both outcomes without creating a second rejected promise.
    const forget = () => passes.delete(pass);
    void pass.then(forget, forget);
    return pass;
  }

  function schedule(delayMs: number): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void runPass();
    }, delayMs);
    unref(timer);
  }

  async function runPass(): Promise<void> {
    try {
      await drainOnce();
    } catch (cause) {
      options.onError?.(toError(cause));
    }
    schedule(intervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const pending = [...inFlight.entries()];
      const active = [...passes];
      if (pending.length === 0 && active.length === 0) return;

      const settled = Promise.allSettled([...active, ...pending.map(([, work]) => work)]);
      const timedOut = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(true), stopTimeoutMs);
        unref(timeout);
        void settled.then(() => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
      if (timedOut) {
        await Promise.allSettled(pending.map(([deliveryId]) => options.outbox.release(deliveryId)));
      }
    },
    drainOnce,
  };
}
