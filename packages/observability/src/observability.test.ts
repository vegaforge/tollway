import { describe, expect, it, vi } from "vitest";
import {
  createMemoryWebhookOutbox,
  createObservabilityHub,
  type DeliveryFailure,
  type PaymentMetric,
  type TollwayEvent,
  verifyWebhookSignature,
  type WebhookEvent,
  type WebhookHandler,
  webhookEvents,
} from "./index.js";

function makeEvent(type: WebhookEvent, data: Record<string, unknown> = {}): TollwayEvent {
  return { id: "evt-test", type, at: "2026-06-26T10:00:00.000Z", data };
}

function noSleep() {
  return Promise.resolve();
}

describe("observability webhook events catalogue", () => {
  it("lists the webhook events from the design document", () => {
    expect(webhookEvents).toContain("receipt.created");
    expect(webhookEvents).toContain("anomaly.detected");
    expect(webhookEvents).toContain("sponsor.low_balance");
    expect(webhookEvents).toHaveLength(6);
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

  it("invokes handlers for all documented event types", async () => {
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
      "Tollway-Event-Id": "evt-test",
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

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: overrides.payer ?? "GAGENTAAA",
    payee: overrides.payee ?? "GSERVICEAAA",
    model: overrides.model ?? "x402",
    amount: overrides.amount ?? "1000",
    asset: overrides.asset ?? "USDC:GA5Z",
    latencyMs: overrides.latencyMs ?? 42,
    outcome: overrides.outcome ?? "settled",
    at: overrides.at ?? "2026-06-26T10:00:00.000Z",
  };
}

describe("observability hub: record + summarize", () => {
  it("returns an empty summary when no metrics have been recorded", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const summary = hub.summarize();
    expect(summary).toEqual({
      totalAmount: "0",
      count: 0,
      byOutcome: { settled: 0, failed: 0, skipped: 0 },
      byAsset: {},
      byModel: {},
      byPayer: {},
      byPayee: {},
      byModelAsset: [],
      byPayerAsset: [],
      byPayeeAsset: [],
    });
  });

  it("collects a single metric and reports it in the rollups", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "1500" }));
    const summary = hub.summarize();
    expect(summary.totalAmount).toBe("1500");
    expect(summary.count).toBe(1);
    expect(summary.byModel).toEqual({ x402: "1500" });
    expect(summary.byPayer).toEqual({ GAGENTAAA: "1500" });
    expect(summary.byPayee).toEqual({ GSERVICEAAA: "1500" });
  });

  it("aggregates per-model totals across mixed settlement models", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ model: "x402", amount: "1000" }));
    hub.record(metric({ model: "x402", amount: "2500" }));
    hub.record(metric({ model: "mpp-charge", amount: "4000" }));
    hub.record(metric({ model: "mpp-channel", amount: "9999" }));

    const summary = hub.summarize();
    expect(summary.totalAmount).toBe("17499");
    expect(summary.count).toBe(4);
    expect(summary.byModel).toEqual({
      x402: "3500",
      "mpp-charge": "4000",
      "mpp-channel": "9999",
    });
  });

  it("aggregates per-payer and per-payee totals across distinct counterparties", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payer: "GAGENT1", payee: "GSERVICE1", amount: "1000" }));
    hub.record(metric({ payer: "GAGENT1", payee: "GSERVICE2", amount: "500" }));
    hub.record(metric({ payer: "GAGENT2", payee: "GSERVICE1", amount: "750" }));

    const summary = hub.summarize();
    expect(summary.byPayer).toEqual({ GAGENT1: "1500", GAGENT2: "750" });
    expect(summary.byPayee).toEqual({ GSERVICE1: "1750", GSERVICE2: "500" });
  });

  it("uses bigint arithmetic so amounts larger than Number.MAX_SAFE_INTEGER round-trip exactly", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    // Two payments of 2^53 each: a plain Number addition would lose precision.
    hub.record(metric({ amount: "9007199254740992" }));
    hub.record(metric({ amount: "9007199254740992" }));
    const summary = hub.summarize();
    expect(summary.totalAmount).toBe("18014398509481984");
    expect(summary.byModel.x402).toBe("18014398509481984");
  });

  it("filters by payer", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payer: "GAGENT1", amount: "100" }));
    hub.record(metric({ payer: "GAGENT2", amount: "200" }));
    expect(hub.summarize({ payer: "GAGENT1" })).toMatchObject({
      totalAmount: "100",
      count: 1,
    });
  });

  it("filters by payee", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payee: "GSERVICE1", amount: "100" }));
    hub.record(metric({ payee: "GSERVICE2", amount: "200" }));
    expect(hub.summarize({ payee: "GSERVICE2" })).toMatchObject({
      totalAmount: "200",
      count: 1,
    });
  });

  it("filters by model", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ model: "x402", amount: "100" }));
    hub.record(metric({ model: "mpp-channel", amount: "9000" }));
    expect(hub.summarize({ model: "mpp-channel" })).toMatchObject({
      totalAmount: "9000",
      count: 1,
    });
  });

  it("filters by inclusive [from, to] timestamp window", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ at: "2026-06-26T09:00:00.000Z", amount: "1" }));
    hub.record(metric({ at: "2026-06-26T10:00:00.000Z", amount: "10" }));
    hub.record(metric({ at: "2026-06-26T11:00:00.000Z", amount: "100" }));

    const summary = hub.summarize({
      from: "2026-06-26T10:00:00.000Z",
      to: "2026-06-26T10:30:00.000Z",
    });
    expect(summary).toMatchObject({ totalAmount: "10", count: 1 });
  });

  it("skips non-integer amounts in rollups but counts them in the matched window", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "100" }));
    hub.record(metric({ amount: "not-a-number" }));
    const summary = hub.summarize();
    // The garbage row is still counted, but it does not poison the sum.
    expect(summary.totalAmount).toBe("100");
    expect(summary.count).toBe(2);
  });

  // Regression for #223: summarize added amounts across assets, so a window
  // holding USDC and XLM reported one total in mixed units. Amounts in
  // different assets cannot be added, so they must be reported per asset.
  it("reports amounts per asset instead of one sum in mixed units", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ asset: "USDC:GA5Z", amount: "1000" }));
    hub.record(metric({ asset: "USDC:GA5Z", amount: "250" }));
    hub.record(metric({ asset: "native", amount: "7" }));

    const summary = hub.summarize();
    expect(summary.byAsset).toEqual({ "USDC:GA5Z": "1250", native: "7" });
  });
});

describe("observability hub: export", () => {
  it("exports an empty JSON array when no metrics match", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    expect(hub.export("json")).toBe("[]");
  });

  it("exports matched metrics as a JSON array of objects", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "100" }));
    hub.record(metric({ amount: "200" }));
    const parsed = JSON.parse(hub.export("json")) as PaymentMetric[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.amount).toBe("100");
    expect(parsed[1]?.amount).toBe("200");
  });

  it("exports a CSV with the column header even when there are no rows", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    expect(hub.export("csv")).toBe("payer,payee,model,amount,asset,latencyMs,outcome,at");
  });

  it("exports matched metrics as a CSV with one row per metric", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ amount: "100", at: "2026-06-26T10:00:00.000Z" }));
    hub.record(metric({ amount: "200", at: "2026-06-26T11:00:00.000Z" }));
    const csv = hub.export("csv");
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("payer,payee,model,amount,asset,latencyMs,outcome,at");
    expect(lines[1]).toContain('"100"');
    expect(lines[1]).toContain('"2026-06-26T10:00:00.000Z"');
    expect(lines[2]).toContain('"200"');
  });

  it("escapes embedded double-quotes in CSV per RFC 4180", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payee: 'service-with-"quote"', amount: "100" }));
    const csv = hub.export("csv");
    expect(csv).toContain('"service-with-""quote"""');
  });

  it("prefixes CSV cells starting with =, +, -, or @ with a single quote to prevent formula injection", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(
      metric({
        payer: "=SUM(A1:A2)",
        payee: "+cmd|'/C calc'!A0",
        amount: "-2+3",
        asset: "@SUM(1+1)",
      }),
    );
    const csv = hub.export("csv");
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      `"'=SUM(A1:A2)","'+cmd|'/C calc'!A0","x402","'-2+3","'@SUM(1+1)",42,"settled","2026-06-26T10:00:00.000Z"`,
    );
  });

  it("prefixes CSV cells starting with a tab or a carriage return", () => {
    // Spreadsheets strip a leading tab or CR and then evaluate what follows,
    // so these two characters need the same neutralization as `=`.
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payer: "\t=SUM(A1:A2)", payee: "\r=SUM(A1:A2)" }));
    const csv = hub.export("csv");
    expect(csv).toContain(`"'\t=SUM(A1:A2)","'\r=SUM(A1:A2)"`);
  });

  it("preserves RFC 4180 quote doubling after adding the formula-injection prefix", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ payee: '=HYPERLINK("https://evil.test","x")' }));
    const csv = hub.export("csv");
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.test"",""x"")"`);
  });

  it("does not prefix ordinary CSV cells with a single quote", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(
      metric({ payer: "GAGENTAAA", payee: "GSERVICE-1", amount: "100", asset: "USDC:GA5Z" }),
    );
    const csv = hub.export("csv");
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      `"GAGENTAAA","GSERVICE-1","x402","100","USDC:GA5Z",42,"settled","2026-06-26T10:00:00.000Z"`,
    );
  });

  it("applies the same query filter to export as to summarize", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    hub.record(metric({ model: "x402", amount: "100" }));
    hub.record(metric({ model: "mpp-channel", amount: "9000" }));

    const json = JSON.parse(hub.export("json", { model: "mpp-channel" })) as PaymentMetric[];
    expect(json).toHaveLength(1);
    expect(json[0]?.amount).toBe("9000");

    const csv = hub.export("csv", { model: "mpp-channel" });
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});

describe("observability hub: durable webhook outbox", () => {
  function okResponse(): Response {
    return new Response(null, { status: 204 });
  }

  it("assigns a stable event id when the input has none", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const seen: TollwayEvent[] = [];
    hub.on("receipt.created", (event) => {
      seen.push(event);
    });

    const report = await hub.emit({
      type: "receipt.created",
      at: "2026-06-26T10:00:00.000Z",
      data: { receiptId: "r-1" },
    });

    expect(report.event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.id).toBe(report.event.id);
  });

  it("keeps a caller-supplied event id", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    const report = await hub.emit(makeEvent("receipt.created"));
    expect(report.event.id).toBe("evt-test");
  });

  it("enqueues one row per matching subscription without calling fetch", async () => {
    const outbox = createMemoryWebhookOutbox();
    const fetcher = vi.fn();
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      outbox,
      webhooks: [
        { id: "sub-a", url: "https://a.test/hook" },
        { id: "sub-b", url: "https://b.test/hook", events: ["anomaly.detected"] },
      ],
    });

    const report = await hub.emit(makeEvent("receipt.created"));

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.webhooksDispatched).toBe(1);
    expect(report.failures).toEqual([]);
    const rows = await outbox.claim(10, 1_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subscriptionId).toBe("sub-a");
    expect(rows[0]?.event.id).toBe("evt-test");
  });

  it("keeps local handlers inline when an outbox is configured", async () => {
    const outbox = createMemoryWebhookOutbox();
    const handler = vi.fn();
    const hub = createObservabilityHub({ sleep: noSleep, outbox });
    hub.on("channel.opened", handler);

    const report = await hub.emit(makeEvent("channel.opened"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(report.handlersDispatched).toBe(1);
  });

  it("never writes the subscription secret or headers into a row", async () => {
    const outbox = createMemoryWebhookOutbox();
    const hub = createObservabilityHub({
      sleep: noSleep,
      outbox,
      webhooks: [
        {
          id: "sub-a",
          url: "https://a.test/hook",
          secret: "whsec_row_secret",
          headers: { Authorization: "Bearer row_token" },
        },
      ],
    });

    await hub.emit(makeEvent("receipt.created"));

    const serialized = JSON.stringify(await outbox.claim(10, 1_000));
    expect(serialized).not.toContain("whsec_row_secret");
    expect(serialized).not.toContain("Bearer row_token");
  });

  it("delivers enqueued rows once the dispatcher is started", async () => {
    const outbox = createMemoryWebhookOutbox();
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      outbox,
      webhooks: [{ id: "sub-a", url: "https://a.test/hook" }],
    });

    await hub.emit(makeEvent("receipt.created"));
    hub.startDispatcher();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await hub.stop();

    expect(await outbox.claim(10, 1_000, Date.now() + 60_000)).toHaveLength(0);
  });

  it("refuses to start a dispatcher without an outbox", () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    expect(() => hub.startDispatcher()).toThrow(/requires an outbox/);
  });

  it("stops cleanly when no dispatcher was started", async () => {
    const hub = createObservabilityHub({ sleep: noSleep });
    await expect(hub.stop()).resolves.toBeUndefined();
  });

  it("signs inline deliveries when the subscription has a secret", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      webhooks: [{ url: "https://a.test/hook", secret: "whsec_inline" }],
    });

    await hub.emit(makeEvent("receipt.created"));

    const [, init] = fetcher.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    await expect(
      verifyWebhookSignature({
        payload: init?.body as string,
        header: headers["Tollway-Signature"] ?? "",
        secret: "whsec_inline",
      }),
    ).resolves.toEqual({ valid: true });
  });
});

describe("observability hub: outbox failure handling", () => {
  it("reports an outbox write failure in the report instead of rejecting", async () => {
    const outbox = createMemoryWebhookOutbox();
    vi.spyOn(outbox, "enqueue").mockRejectedValue(new Error("database is locked"));
    const onDeliveryFailure = vi.fn();
    const hub = createObservabilityHub({
      sleep: noSleep,
      outbox,
      onDeliveryFailure,
      webhooks: [
        { id: "sub-a", url: "https://a.test/hook" },
        { id: "sub-b", url: "https://b.test/hook" },
      ],
    });

    const report = await hub.emit(makeEvent("receipt.created"));

    expect(report.webhooksDispatched).toBe(0);
    expect(report.failures.map((failure) => failure.target)).toEqual([
      { kind: "webhook", url: "https://a.test/hook" },
      { kind: "webhook", url: "https://b.test/hook" },
    ]);
    expect(report.failures[0]?.error.message).toBe("database is locked");
    expect(report.failures[0]?.attempts).toBe(0);
    expect(onDeliveryFailure).toHaveBeenCalledTimes(2);
  });

  it("does not give the outbox the inline retry policy", async () => {
    // retry is sized for retries inside one emit call. With it inherited, a
    // receiver that is down for one attempt would dead-letter at once.
    const outbox = createMemoryWebhookOutbox();
    const fetcher = vi.fn().mockRejectedValue(new Error("connection refused"));
    const hub = createObservabilityHub({
      sleep: noSleep,
      fetch: fetcher,
      outbox,
      retry: { maxAttempts: 1 },
      webhooks: [{ id: "sub-a", url: "https://a.test/hook" }],
    });

    await hub.emit(makeEvent("receipt.created"));
    hub.startDispatcher();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await hub.stop();

    expect(await outbox.listDeadLetters()).toHaveLength(0);
  });

  it("refuses an outbox without a request timeout", () => {
    expect(() =>
      createObservabilityHub({ outbox: createMemoryWebhookOutbox(), requestTimeoutMs: 0 }),
    ).toThrow(/requestTimeoutMs/);
  });

  it("refuses an empty webhook secret, at construction and when added later", () => {
    expect(() =>
      createObservabilityHub({ webhooks: [{ url: "https://a.test/hook", secret: "" }] }),
    ).toThrow(/must not be empty/);
    const hub = createObservabilityHub();
    expect(() => hub.addWebhook({ url: "https://a.test/hook", secret: "" })).toThrow(
      /must not be empty/,
    );
  });
});
