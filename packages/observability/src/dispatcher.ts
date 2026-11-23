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
import type { WebhookDelivery, WebhookLease, WebhookOutbox } from "./outbox.js";
import { buildWebhookRequest, postWebhook } from "./webhook-http.js";

/**
 * Knobs a hub passes through; tests set them to keep time deterministic.
 *
 * The defaults are sized for an outage, not a blip: 16 attempts with backoff
 * from 1 second doubling to a 1 hour cap retry for between about 2 and 4
 * hours (the jitter decides where) before a row dead-letters.
 */
export type WebhookDispatcherTuning = {
  /** Attempts per delivery before dead-lettering. Defaults to 16. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 1000ms. */
  initialDelayMs?: number;
  /** Multiplier between attempts. Defaults to 2. */
  backoffFactor?: number;
  /** Upper bound on one backoff delay. Defaults to 3600000ms (1 hour). */
  maxDelayMs?: number;
  /** Rows claimed per pass. Defaults to 20. */
  batchSize?: number;
  /**
   * How long a claimed row stays leased. Must be longer than
   * `requestTimeoutMs`, so a lease cannot expire while its request may still
   * be open. Defaults to 30000ms.
   */
  leaseMs?: number;
  /** Idle time between passes. Defaults to 1000ms. */
  intervalMs?: number;
  /**
   * How long `stop()` waits for in-flight deliveries before it aborts them.
   * Defaults to 5000ms.
   */
  stopTimeoutMs?: number;
  /**
   * How long a delivered row is kept before the dispatcher purges it.
   * Defaults to 86400000ms (24 hours). Dead letters are never purged.
   */
  deliveredRetentionMs?: number;
  /** How often the dispatcher purges delivered rows. Defaults to 60000ms. */
  purgeIntervalMs?: number;
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
  /**
   * Per-attempt request timeout, at least 1ms and shorter than `leaseMs`. An
   * outbox delivery always has one, so a stalled receiver cannot outlive its
   * lease.
   */
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
  /**
   * Called when a pass fails, for example because the store rejected a
   * claim, and with a {@link WebhookLeaseLostError} when a result could not
   * be recorded because the lease had already passed to another dispatcher.
   */
  onError?: (error: Error) => void;
};

export type WebhookDispatcher = {
  /** Starts the timer loop. Calling it twice is a no-op. */
  start(): void;
  /**
   * Stops scheduling passes and waits for in-flight deliveries up to
   * `stopTimeoutMs`. Requests still open after that are aborted first, and
   * only then are their leases released, so another dispatcher never sends
   * a row while this one still has a request for it open.
   */
  stop(): Promise<void>;
  /** Runs one claim-and-deliver pass. Returns the number of rows handled. */
  drainOnce(): Promise<number>;
};

/**
 * A result the dispatcher could not record, because its lease on the row
 * had expired and another dispatcher had claimed it. Nothing was
 * overwritten; the other dispatcher's result stands.
 */
export class WebhookLeaseLostError extends Error {
  readonly deliveryId: string;
  /** What the dispatcher tried to record. */
  readonly result: "delivered" | "failed" | "dead-letter" | "released";

  constructor(deliveryId: string, result: WebhookLeaseLostError["result"]) {
    super(
      `lost the lease on webhook delivery ${deliveryId} before recording it as ${result}; another dispatcher owns the row`,
    );
    this.name = "WebhookLeaseLostError";
    this.deliveryId = deliveryId;
    this.result = result;
  }
}

const DEFAULTS = {
  maxAttempts: 16,
  initialDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 3_600_000,
  batchSize: 20,
  leaseMs: 30_000,
  intervalMs: 1_000,
  stopTimeoutMs: 5_000,
  deliveredRetentionMs: 86_400_000,
  purgeIntervalMs: 60_000,
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
  const deliveredRetentionMs = options.deliveredRetentionMs ?? DEFAULTS.deliveredRetentionMs;
  const purgeIntervalMs = options.purgeIntervalMs ?? DEFAULTS.purgeIntervalMs;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const { requestTimeoutMs } = options;

  assertOption(maxAttempts, "maxAttempts", 1, true);
  assertOption(initialDelayMs, "initialDelayMs", 0, true);
  assertOption(backoffFactor, "backoffFactor", 1, false);
  assertOption(maxDelayMs, "maxDelayMs", 0, true);
  assertOption(batchSize, "batchSize", 1, true);
  assertOption(leaseMs, "leaseMs", 1, true);
  assertOption(intervalMs, "intervalMs", 0, true);
  assertOption(stopTimeoutMs, "stopTimeoutMs", 0, true);
  assertOption(deliveredRetentionMs, "deliveredRetentionMs", 0, true);
  assertOption(purgeIntervalMs, "purgeIntervalMs", 1, true);
  // A request with no timeout, or one longer than the lease, could still be
  // open when another dispatcher reclaims the row and sends it again.
  assertOption(requestTimeoutMs, "requestTimeoutMs", 1, true);
  if (leaseMs <= requestTimeoutMs) {
    throw new RangeError(
      `leaseMs (${leaseMs}) must be longer than requestTimeoutMs (${requestTimeoutMs}), so a lease cannot expire while its request is open`,
    );
  }

  let running = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPurgeAt: number | null = null;
  const inFlight = new Map<string, { work: Promise<void>; abort: AbortController }>();
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

  /** Reports a write that found the lease gone. Returns whether it applied. */
  function checkApplied(
    applied: boolean,
    delivery: WebhookDelivery,
    result: WebhookLeaseLostError["result"],
  ): boolean {
    if (!applied) options.onError?.(new WebhookLeaseLostError(delivery.id, result));
    return applied;
  }

  function leaseOf(delivery: WebhookDelivery): WebhookLease {
    if (delivery.leaseToken === null) {
      throw new Error(`webhook delivery ${delivery.id} was handed out without a lease token`);
    }
    return { deliveryId: delivery.id, leaseToken: delivery.leaseToken };
  }

  async function deliver(delivery: WebhookDelivery, abort: AbortController): Promise<void> {
    const lease = leaseOf(delivery);
    const subscription = options.resolveSubscription(delivery.subscriptionId);
    if (!subscription) {
      const error = new Error(
        `webhook subscription ${delivery.subscriptionId} is no longer registered`,
      );
      // Nothing was sent, so this does not count as an attempt.
      const applied = await options.outbox.deadLetter(lease, error.message, {
        countAttempt: false,
        now: now(),
      });
      if (checkApplied(applied, delivery, "dead-letter")) {
        report(delivery, undefined, error, delivery.attempts);
      }
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
        timeoutMs: requestTimeoutMs,
        signal: abort.signal,
      });
    } catch (cause) {
      if (abort.signal.aborted) {
        // stop() aborted the request: hand the row back without counting an
        // attempt. The request is no longer open, so releasing is safe.
        checkApplied(await options.outbox.release(lease), delivery, "released");
        return;
      }
      const error = toError(cause);
      const attempts = delivery.attempts + 1;
      if (attempts >= maxAttempts) {
        const applied = await options.outbox.deadLetter(lease, error.message, { now: now() });
        if (checkApplied(applied, delivery, "dead-letter")) {
          report(delivery, subscription.url, error, attempts);
        }
      } else {
        const applied = await options.outbox.markFailed(
          lease,
          now() + backoffDelay(attempts),
          error.message,
        );
        checkApplied(applied, delivery, "failed");
      }
      return;
    }
    checkApplied(await options.outbox.markDelivered(lease, now()), delivery, "delivered");
  }

  /** Purges delivered rows past retention, at most once per purge interval. */
  async function purgeIfDue(): Promise<void> {
    const at = now();
    if (lastPurgeAt !== null && at - lastPurgeAt < purgeIntervalMs) return;
    lastPurgeAt = at;
    await options.outbox.purgeDelivered(Math.max(0, at - deliveredRetentionMs));
  }

  async function drainPass(): Promise<number> {
    const claimed = await options.outbox.claim(batchSize, leaseMs, now());
    if (stopping) {
      // stop() gave up waiting while this claim was in progress: hand the
      // rows straight back instead of starting requests it cannot wait for.
      await Promise.all(
        claimed.map(async (delivery) =>
          checkApplied(await options.outbox.release(leaseOf(delivery)), delivery, "released"),
        ),
      );
      return claimed.length;
    }
    await Promise.all(
      claimed.map((delivery) => {
        const abort = new AbortController();
        const work = deliver(delivery, abort).finally(() => {
          inFlight.delete(delivery.id);
        });
        inFlight.set(delivery.id, { work, abort });
        return work;
      }),
    );
    await purgeIfDue();
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
      stopping = false;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const active = [...passes];
      if (inFlight.size === 0 && active.length === 0) return;

      const settled = Promise.allSettled([
        ...active,
        ...[...inFlight.values()].map((entry) => entry.work),
      ]);
      const timedOut = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(true), stopTimeoutMs);
        unref(timeout);
        void settled.then(() => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
      if (!timedOut) return;

      // Abort every open request, then wait for each delivery to release its
      // own lease. A pass still claiming releases what it claims.
      stopping = true;
      for (const entry of inFlight.values()) entry.abort.abort();
      await Promise.allSettled([
        ...[...passes],
        ...[...inFlight.values()].map((entry) => entry.work),
      ]);
    },
    drainOnce,
  };
}
