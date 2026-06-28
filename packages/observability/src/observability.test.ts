import { NotImplementedError } from "@tollway/core";
import { describe, expect, it, vi } from "vitest";
import {
  createObservabilityHub,
  type DeliveryFailure,
  type TollwayEvent,
  type WebhookEvent,
  type WebhookHandler,
  webhookEvents,
} from "./index.js";

function makeEvent(type: WebhookEvent, data: Record<string, unknown> = {}): TollwayEvent {
  return { type, at: "2026-06-26T10:00:00.000Z", data };
}

function noSleep() {
  return Promise.resolve();
}

describe("observability webhook events catalogue", () => {
  it("lists the webhook events from the design document", () => {
    expect(webhookEvents).toContain("receipt.created");
    expect(webhookEvents).toContain("anomaly.detected");
    expect(webhookEvents).toHaveLength(5);
  });
});

describe("observability hub: handler registration", () => {
  it("delivers every registered handler the matching event", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const received: TollwayEvent[] = [];
    const handler: WebhookHandler = (event) => {
      received.push(event);
    };
    hub.on("receipt.created", handler);

    const event = makeEvent("receipt.created", { receiptId: "r-1" });
    const report = await hub.emit(event);

    expect(received).toEqual([event]);
    expect(report.handlersDispatched).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("invokes handlers for all five documented event types", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const calls: WebhookEvent[] = [];
    for (const eventType of webhookEvents) {
      hub.on(eventType, (event) => {
        calls.push(event.type);
      });
    }

    for (const eventType of webhookEvents) {
      await hub.emit(makeEvent(eventType));
    }

    expect(calls).toEqual([...webhookEvents]);
  });

  it("does not invoke handlers registered for a different event type", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const handler = vi.fn();
    hub.on("anomaly.detected", handler);

    await hub.emit(makeEvent("receipt.created"));

    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates handler failures so other handlers still run", async () => {
    const hub = createObservabilityHub({ sleep: noSleep, retry: { maxAttempts: 1 } });
    const surviving = vi.fn();
    hub.on("channel.opened", () => {
      throw new Error("first handler exploded");
    });
    hub.on("channel.opened", surviving);

    const report = await hub.emit(makeEvent("channel.opened"));

    expect(surviving).toHaveBeenCalledTimes(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.target).toEqual({ kind: "handler", index: 0 });
    expect(report.failures[0]?.error.message).toBe("first handler exploded");
  });
});

describe("observability hub: external webhook delivery", () => {
  function okResponse(): Response {
    return new Response(null, { status: 204 });
  }

  it("POSTs the event JSON to subscribed URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      webhooks: [{ url: "https://example.test/hook" }],
    });

    const event = makeEvent("receipt.created", { receiptId: "r-1" });
    const report = await hub.emit(event);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const firstCall = fetcher.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? [];
    expect(url).toBe("https://example.test/hook");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init?.body as string)).toEqual(event);
    expect(report.webhooksDispatched).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("respects per-subscription event filters", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      webhooks: [
        { url: "https://channels.test/hook", events: ["channel.opened", "channel.closed"] },
        { url: "https://anomaly.test/hook", events: ["anomaly.detected"] },
      ],
    });

    await hub.emit(makeEvent("channel.opened"));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://channels.test/hook");
  });

  it("merges per-subscription headers into the POST", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      webhooks: [
        {
          url: "https://example.test/hook",
          headers: { Authorization: "Bearer abc" },
        },
      ],
    });

    await hub.emit(makeEvent("budget.warning"));

    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer abc",
    });
  });

  it("accepts subscriptions registered after construction", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({ sleep: noSleep, fetch: fetcher });
    hub.addWebhook({ url: "https://late.test/hook" });

    await hub.emit(makeEvent("anomaly.detected"));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://late.test/hook");
  });
});

describe("observability hub: retry and failure surfacing", () => {
  it("retries the configured number of attempts on transient failure", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      retry: { maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1 },
      webhooks: [{ url: "https://flaky.test/hook" }],
    });

    const report = await hub.emit(makeEvent("receipt.created"));

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(report.failures).toEqual([]);
  });

  it("surfaces a failure after exhausting retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("broken", { status: 500, statusText: "Server Error" }));
    const collected: DeliveryFailure[] = [];
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      retry: { maxAttempts: 2, initialDelayMs: 0, backoffFactor: 1 },
      webhooks: [{ url: "https://dead.test/hook" }],
      onDeliveryFailure: (failure) => collected.push(failure),
    });

    const report = await hub.emit(makeEvent("budget.warning"));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.target).toEqual({
      kind: "webhook",
      url: "https://dead.test/hook",
    });
    expect(report.failures[0]?.attempts).toBe(2);
    expect(report.failures[0]?.error.message).toContain("500");
    expect(collected).toEqual(report.failures);
  });

  it("retries handler failures and surfaces persistent ones", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const hub = createObservabilityHub({
      sleep: noSleep,
      retry: { maxAttempts: 3, initialDelayMs: 0, backoffFactor: 1 },
    });
    hub.on("anomaly.detected", handler);

    const report = await hub.emit(makeEvent("anomaly.detected"));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.target).toEqual({ kind: "handler", index: 0 });
    expect(report.failures[0]?.attempts).toBe(3);
  });

  it("waits with the configured backoff between retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const hub = createObservabilityHub({
      fetch: fetcher,
      sleep,
      retry: { maxAttempts: 2, initialDelayMs: 50, backoffFactor: 3 },
      webhooks: [{ url: "https://backoff.test/hook" }],
    });

    await hub.emit(makeEvent("channel.closed"));

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("converts non-Error rejections from handlers into Error instances", async () => {
    const hub = createObservabilityHub({
      sleep: noSleep,
      retry: { maxAttempts: 1 },
    });
    hub.on("receipt.created", async () => {
      throw "literal string";
    });

    const report = await hub.emit(makeEvent("receipt.created"));

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toBeInstanceOf(Error);
    expect(report.failures[0]?.error.message).toBe("literal string");
  });

  it("aborts a stalled fetch after requestTimeoutMs and surfaces it like any other failure", async () => {
    const fetcher = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          // Without a signal the fetch would hang the test forever; assert
          // the hub always passes one through so this branch is unreachable.
          reject(new Error("expected AbortSignal to be supplied by the hub"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      requestTimeoutMs: 25,
      retry: { maxAttempts: 2, initialDelayMs: 0, backoffFactor: 1 },
      webhooks: [{ url: "https://stalls.test/hook" }],
    });

    const report = await hub.emit(makeEvent("receipt.created"));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.target).toEqual({
      kind: "webhook",
      url: "https://stalls.test/hook",
    });
    expect(report.failures[0]?.attempts).toBe(2);
    expect(report.failures[0]?.error.message).toContain("timed out after 25ms");
  });

  it("recovers when a stalled attempt is followed by a successful one within timeout", async () => {
    let call = 0;
    const fetcher = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      requestTimeoutMs: 25,
      retry: { maxAttempts: 2, initialDelayMs: 0, backoffFactor: 1 },
      webhooks: [{ url: "https://recovers.test/hook" }],
    });

    const report = await hub.emit(makeEvent("channel.opened"));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report.failures).toEqual([]);
    expect(report.webhooksDispatched).toBe(1);
  });

  it("disables the timeout when requestTimeoutMs is zero", async () => {
    let captured: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      captured = init?.signal as AbortSignal | undefined;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      requestTimeoutMs: 0,
      webhooks: [{ url: "https://noop.test/hook" }],
    });

    await hub.emit(makeEvent("budget.warning"));

    expect(fetcher).toHaveBeenCalledTimes(1);
    // The hub still passes a signal so callers can manually abort, but it must
    // never fire on its own when timeouts are disabled.
    expect(captured?.aborted).toBe(false);
  });
});

describe("observability hub: metric methods", () => {
  it("throws NotImplementedError for record/summarize/export until #31 lands", () => {
    const hub = createObservabilityHub({ sleep: noSleep });

    expect(() =>
      hub.record({
        payer: "agent",
        payee: "service",
        model: "x402",
        amount: "1",
        asset: "USDC",
        latencyMs: 100,
        outcome: "settled",
        at: "2026-06-26T10:00:00.000Z",
      }),
    ).toThrow(NotImplementedError);

    expect(() => hub.summarize()).toThrow(NotImplementedError);
    expect(() => hub.export("json")).toThrow(NotImplementedError);
  });
});
