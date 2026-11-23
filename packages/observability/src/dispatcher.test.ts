import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebhookDispatcher, type WebhookDispatcher } from "./dispatcher.js";
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
    requestTimeoutMs: 0,
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
    expect(dead[0]?.attempts).toBe(1);
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
      requestTimeoutMs: 0,
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
        requestTimeoutMs: 0,
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

  it("leaves the row claimable when stop finds work in flight", async () => {
    let release: (response: Response) => void = () => {};
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const { outbox } = setup({ fetcher });
    const stopping = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: fetcher,
      requestTimeoutMs: 0,
      now: () => Date.now() + 60_000,
      stopTimeoutMs: 0,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const pass = stopping.drainOnce();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await stopping.stop();

    expect(await outbox.claim(10, 1_000, Date.now() + 120_000)).toHaveLength(1);

    release(okResponse());
    await pass;
  });

  it("reports a claim failure through onError instead of crashing", async () => {
    const onError = vi.fn();
    const outbox = createMemoryWebhookOutbox();
    vi.spyOn(outbox, "claim").mockRejectedValue(new Error("database is locked"));
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: vi.fn(),
      requestTimeoutMs: 0,
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
        requestTimeoutMs: 0,
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
