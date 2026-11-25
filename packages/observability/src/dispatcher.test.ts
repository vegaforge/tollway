import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookDispatcher,
  type WebhookDispatcher,
  WebhookLeaseLostError,
} from "./dispatcher.js";
import type { TollwayEvent } from "./events.js";
import type { WebhookSubscription } from "./index.js";
import { createMemoryWebhookOutbox, createSqliteWebhookOutbox } from "./outbox.js";
import { verifyWebhookSignature } from "./webhook-signature.js";

const event: TollwayEvent = {
  id: "evt-1",
  type: "receipt.created",
  at: "2026-11-23T00:00:00.000Z",
  data: { receiptId: "r-1" },
};

const subscription: WebhookSubscription = {
  id: "sub-1",
  url: "https://example.test/hook",
  secret: "whsec_test",
  headers: { Authorization: "Bearer abc" },
};

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

type Setup = {
  dispatcher: WebhookDispatcher;
  outbox: ReturnType<typeof createMemoryWebhookOutbox>;
};

function setup(input: {
  fetcher: typeof globalThis.fetch;
  maxAttempts?: number;
  now?: () => number;
  onDeliveryFailure?: (failure: { attempts: number; error: Error; url?: string }) => void;
  onError?: (error: Error) => void;
}): Setup {
  const outbox = createMemoryWebhookOutbox();
  const dispatcher = createWebhookDispatcher({
    outbox,
    resolveSubscription: (id) => (id === subscription.id ? subscription : undefined),
    fetch: input.fetcher,
    requestTimeoutMs: 5_000,
    batchSize: 20,
    leaseMs: 60_000,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    maxAttempts: input.maxAttempts ?? 3,
    random: () => 0,
    now: input.now ?? (() => Date.now() + 60_000),
    onDeliveryFailure: input.onDeliveryFailure,
    onError: input.onError,
  });
  return { dispatcher, outbox };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("webhook dispatcher", () => {
  it("delivers a claimed row and marks it delivered", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const { dispatcher, outbox } = setup({ fetcher });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    expect(await dispatcher.drainOnce()).toBe(1);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(subscription.url);
    expect(init).toMatchObject({ method: "POST" });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers["Tollway-Event-Id"]).toBe("evt-1");
    expect(headers["Tollway-Delivery-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init?.body as string)).toEqual(event);
    expect(await outbox.claim(10, 1_000, 10_000_000)).toHaveLength(0);
  });

  it("signs every attempt over the bytes it sends", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const { dispatcher, outbox } = setup({ fetcher });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    await dispatcher.drainOnce();

    const [, init] = fetcher.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const header = headers["Tollway-Signature"];
    expect(header).toBeDefined();
    await expect(
      verifyWebhookSignature({
        payload: init?.body as string,
        header: header ?? "",
        secret: "whsec_test",
      }),
    ).resolves.toEqual({ valid: true });
  });

  it("backs off a failed attempt and delivers on the retry", async () => {
    let now = Date.now() + 60_000;
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(okResponse());
    const { dispatcher, outbox } = setup({ fetcher, now: () => now });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    expect(await dispatcher.drainOnce()).toBe(1);
    expect(await dispatcher.drainOnce()).toBe(0);

    now += 500;
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await outbox.claim(10, 1_000, now + 60_000)).toHaveLength(0);
  });

  it("dead-letters after the last attempt and reports it once", async () => {
    let now = Date.now() + 60_000;
    const onDeliveryFailure = vi.fn();
    const fetcher = vi.fn().mockRejectedValue(new Error("upstream down"));
    const { dispatcher, outbox } = setup({
      fetcher,
      maxAttempts: 2,
      now: () => now,
      onDeliveryFailure,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    await dispatcher.drainOnce();
    expect(onDeliveryFailure).not.toHaveBeenCalled();

    now += 500;
    await dispatcher.drainOnce();

    const dead = await outbox.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toBe("upstream down");
    // Both POSTs count, the final one included.
    expect(dead[0]?.attempts).toBe(2);
    expect(onDeliveryFailure).toHaveBeenCalledTimes(1);
    expect(onDeliveryFailure.mock.calls[0]?.[0]).toMatchObject({
      url: subscription.url,
      attempts: 2,
    });
  });

  it("signs retries with a fresh timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T00:00:00.000Z"));
    let now = Date.now();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(okResponse());
    const { dispatcher, outbox } = setup({ fetcher, now: () => now });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    await dispatcher.drainOnce();
    vi.setSystemTime(new Date("2026-11-23T00:01:40.000Z"));
    now += 500;
    await dispatcher.drainOnce();

    const timestamps = fetcher.mock.calls.map(([, init]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return Number(/^t=(\d+),/.exec(headers["Tollway-Signature"] ?? "")?.[1]);
    });
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]).toBe((timestamps[0] ?? 0) + 100);
  });

  it("dead-letters a row whose subscription is no longer registered", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const outbox = createMemoryWebhookOutbox();
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => undefined,
      fetch: fetcher,
      requestTimeoutMs: 5_000,
      now: () => Date.now() + 60_000,
    });
    await outbox.enqueue([{ subscriptionId: "gone", event }]);

    await dispatcher.drainOnce();

    const dead = await outbox.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toMatch(/no longer registered/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("delivers each row exactly once when two dispatchers share the store", async () => {
    const seen: string[] = [];
    const fetcher = vi
      .fn()
      .mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(((init?.headers ?? {}) as Record<string, string>)["Tollway-Delivery-Id"] ?? "");
        return okResponse();
      });
    const outbox = createMemoryWebhookOutbox();
    const make = () =>
      createWebhookDispatcher({
        outbox,
        resolveSubscription: () => subscription,
        fetch: fetcher,
        requestTimeoutMs: 5_000,
        now: () => Date.now() + 60_000,
        random: () => 0,
      });
    const first = make();
    const second = make();
    await outbox.enqueue(Array.from({ length: 5 }, () => ({ subscriptionId: "sub-1", event })));

    await Promise.all([first.drainOnce(), second.drainOnce()]);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("aborts an open request before stop releases its lease", async () => {
    // The fetch never settles on its own, so only the abort can end it.
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn().mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    const outbox = createMemoryWebhookOutbox();
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetcher,
      requestTimeoutMs: 5_000,
      now: () => Date.now() + 60_000,
      stopTimeoutMs: 0,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const pass = dispatcher.drainOnce();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await dispatcher.stop();

    // By the time stop resolves, the request was aborted and the pass ended.
    expect(signals[0]?.aborted).toBe(true);
    await expect(pass).resolves.toBe(1);
    // The row is back, with no attempt counted for the aborted request.
    const [row] = await outbox.claim(10, 1_000, Date.now() + 120_000);
    expect(row?.attempts).toBe(0);
  });

  it("aborts even when the fetch implementation ignores its signal", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    const outbox = createMemoryWebhookOutbox();
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetcher,
      requestTimeoutMs: 5_000,
      now: () => Date.now() + 60_000,
      stopTimeoutMs: 0,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const pass = dispatcher.drainOnce();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await dispatcher.stop();

    await expect(pass).resolves.toBe(1);
    expect(await outbox.claim(10, 1_000, Date.now() + 120_000)).toHaveLength(1);
  });

  it("never lets a dispatcher whose lease expired overwrite another's delivery", async () => {
    // A claims the row and its POST hangs. A's lease expires, B reclaims the
    // row and delivers it. A's POST then fails on its last attempt: A must
    // not dead-letter the row, or a replay would send it a second time.
    //
    // Time is driven explicitly. Only setTimeout is faked, so A's request
    // timeout cannot fire while the test is still arranging B, however slow
    // the machine is. The row is enqueued before `start` is read: enqueue
    // stamps `nextAttemptAt` with the real clock, and A, frozen at `start`,
    // must see the row as due.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outbox = createMemoryWebhookOutbox();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
    const start = Date.now();
    let failA: (error: Error) => void = () => {};
    let fetchAStarted: () => void = () => {};
    const fetchAStartedPromise = new Promise<void>((resolve) => {
      fetchAStarted = resolve;
    });
    const fetchA = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          failA = reject;
          fetchAStarted();
        }),
    );
    const fetchB = vi.fn().mockResolvedValue(okResponse());
    const onErrorA = vi.fn();
    const onDeliveryFailureA = vi.fn();
    const a = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetchA,
      requestTimeoutMs: 1_000,
      leaseMs: 2_000,
      maxAttempts: 1,
      now: () => start,
      onError: onErrorA,
      onDeliveryFailure: onDeliveryFailureA,
    });
    const b = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetchB,
      requestTimeoutMs: 1_000,
      leaseMs: 2_000,
      now: () => start + 2_001,
    });

    const passA = a.drainOnce();
    await fetchAStartedPromise;
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(await b.drainOnce()).toBe(1);
    failA(new Error("connection reset"));
    await passA;

    expect(await outbox.listDeadLetters()).toHaveLength(0);
    expect(onDeliveryFailureA).not.toHaveBeenCalled();
    expect(onErrorA).toHaveBeenCalledTimes(1);
    const lost = onErrorA.mock.calls[0]?.[0];
    expect(lost).toBeInstanceOf(WebhookLeaseLostError);
    expect(lost).toMatchObject({ result: "dead-letter" });
  });

  it.each([
    ["no request timeout", { requestTimeoutMs: 0 }],
    ["a request timeout as long as the lease", { requestTimeoutMs: 30_000, leaseMs: 30_000 }],
    ["a request timeout longer than the lease", { requestTimeoutMs: 60_000, leaseMs: 30_000 }],
  ])("refuses %s, which could let a lease expire mid-request", (_name, timing) => {
    expect(() =>
      createWebhookDispatcher({
        outbox: createMemoryWebhookOutbox(),
        resolveSubscription: () => subscription,
        fetch: vi.fn(),
        ...timing,
      }),
    ).toThrow(RangeError);
  });

  it("purges delivered rows once they pass the retention window", async () => {
    let now = Date.now() + 60_000;
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const outbox = createMemoryWebhookOutbox();
    const purge = vi.spyOn(outbox, "purgeDelivered");
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetcher,
      requestTimeoutMs: 5_000,
      deliveredRetentionMs: 10_000,
      purgeIntervalMs: 1_000,
      now: () => now,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    await dispatcher.drainOnce();
    expect(purge).toHaveBeenLastCalledWith(now - 10_000);
    expect(await purge.mock.results[0]?.value).toBe(0);

    // Within the purge interval, no second purge runs.
    now += 500;
    await dispatcher.drainOnce();
    expect(purge).toHaveBeenCalledTimes(1);

    // Past the retention window, the delivered row is removed.
    now += 10_000;
    await dispatcher.drainOnce();
    expect(purge).toHaveBeenCalledTimes(2);
    expect(await purge.mock.results[1]?.value).toBe(1);
  });

  it("reports a claim failure through onError instead of crashing", async () => {
    const onError = vi.fn();
    const outbox = createMemoryWebhookOutbox();
    vi.spyOn(outbox, "claim").mockRejectedValue(new Error("database is locked"));
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: vi.fn(),
      requestTimeoutMs: 5_000,
      intervalMs: 0,
      onError,
    });

    dispatcher.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await dispatcher.stop();

    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe("webhook dispatcher: sqlite restart", () => {
  it("delivers rows enqueued before a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tollway-dispatch-"));
    const filename = join(directory, "outbox.db");
    const fetcher = vi.fn().mockResolvedValue(okResponse());

    try {
      const before = createSqliteWebhookOutbox({ filename });
      await before.enqueue([{ subscriptionId: "sub-1", event }]);
      before.close();

      const after = createSqliteWebhookOutbox({ filename });
      const dispatcher = createWebhookDispatcher({
        outbox: after,
        resolveSubscription: () => subscription,
        fetch: fetcher,
        requestTimeoutMs: 5_000,
        now: () => Date.now() + 60_000,
      });
      try {
        expect(await dispatcher.drainOnce()).toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(await after.claim(10, 1_000, Date.now() + 120_000)).toHaveLength(0);
      } finally {
        after.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
