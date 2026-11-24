import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservabilityHub, type PaymentMetric } from "./index.js";
import { createMemoryMetricsStore } from "./memory-metrics-store.js";
import { InvalidMetricError, type MetricsStore } from "./metrics-store.js";

function metric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: "GPAYER",
    payee: "GSERVICE",
    model: "x402",
    amount: "100",
    asset: "USDC:GA5Z",
    latencyMs: 40,
    outcome: "settled",
    at: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

/** A store that counts appends and can be made to fail. */
function spyStore(fail = false): MetricsStore & { append: ReturnType<typeof vi.fn> } {
  const inner = createMemoryMetricsStore();
  const append = vi.fn(async (metrics: readonly PaymentMetric[]) => {
    if (fail) throw new Error("disk full");
    await inner.append(metrics);
  });
  return { ...inner, append };
}

const hubs: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});

function hubWith(store: MetricsStore, extra: Parameters<typeof createObservabilityHub>[0] = {}) {
  const hub = createObservabilityHub({
    store,
    onStoreError: (error) => {
      throw error;
    },
    ...extra,
  });
  hubs.push(hub);
  return hub;
}

describe("observability hub with a metrics store", () => {
  it("needs onStoreError, so a failed write cannot be lost", () => {
    expect(() => createObservabilityHub({ store: createMemoryMetricsStore() })).toThrow(TypeError);
  });

  it("buffers record() and writes the buffer on flush()", async () => {
    const store = spyStore();
    const hub = hubWith(store);
    hub.record(metric());
    hub.record(metric({ amount: "5" }));
    expect(store.append).not.toHaveBeenCalled();

    await hub.flush();
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.append.mock.calls[0]?.[0]).toHaveLength(2);
    expect((await hub.summarizeAsync()).totalAmount).toBe("105");
  });

  it("writes a full batch at once, without waiting for the timer", async () => {
    const store = spyStore();
    const hub = hubWith(store, { storeBuffer: { maxBatchSize: 2, flushIntervalMs: 60_000 } });
    hub.record(metric());
    hub.record(metric());
    hub.record(metric());
    await vi.waitFor(() => expect(store.append).toHaveBeenCalledTimes(1));
    expect(store.append.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("flushes a partly full buffer on the timer", async () => {
    vi.useFakeTimers();
    try {
      const store = spyStore();
      const hub = hubWith(store, { storeBuffer: { flushIntervalMs: 50 } });
      hub.record(metric());
      expect(store.append).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(store.append).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a failed batch to onStoreError and keeps working", async () => {
    const store = spyStore(true);
    const onStoreError = vi.fn();
    const hub = createObservabilityHub({ store, onStoreError });
    hubs.push({ close: async () => undefined });
    hub.record(metric());
    await hub.flush();
    expect(onStoreError).toHaveBeenCalledTimes(1);
    expect(onStoreError.mock.calls[0]?.[0]).toMatchObject({ message: "disk full" });
    expect(onStoreError.mock.calls[0]?.[1]).toEqual([metric()]);

    hub.record(metric());
    await hub.flush();
    expect(onStoreError).toHaveBeenCalledTimes(2);
  });

  it("drains the buffer on close() and refuses later records", async () => {
    const store = spyStore();
    const hub = createObservabilityHub({ store, onStoreError: vi.fn() });
    hub.record(metric());
    await hub.close();
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(() => hub.record(metric())).toThrow(/closed/);
  });

  it("refuses a malformed metric when it is recorded, with a typed error", () => {
    const hub = hubWith(spyStore());
    expect(() => hub.record(metric({ amount: "12.5" }))).toThrow(InvalidMetricError);
  });

  it("sends synchronous readers to their async counterparts", () => {
    const hub = hubWith(spyStore());
    expect(() => hub.summarize()).toThrow(/summarizeAsync/);
    expect(() => hub.export("json")).toThrow(/exportAsync/);
    expect(() =>
      hub.timeseries({ from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z", bucket: "1h" }),
    ).toThrow(/queryMetrics/);
  });

  it("exports every stored page, in the same format as the in-memory hub", async () => {
    const metrics = Array.from({ length: 1205 }, (_, index) =>
      metric({
        amount: String(index),
        at: new Date(Date.UTC(2026, 10, 20, 0, 0, index)).toISOString(),
      }),
    );
    const stored = hubWith(spyStore(), { storeBuffer: { maxBatchSize: 1000 } });
    const memory = createObservabilityHub();
    for (const m of metrics) {
      stored.record(m);
      memory.record(m);
    }
    await stored.flush();
    expect(await stored.exportAsync("csv")).toBe(memory.export("csv"));
    expect(await stored.exportAsync("json")).toBe(memory.export("json"));
  });
});

describe("observability hub without a store", () => {
  it("answers the async readers from memory, exactly as the sync ones", async () => {
    const hub = createObservabilityHub();
    hub.record(metric());
    hub.record(metric({ payee: "GOTHER", amount: "3" }));
    expect(await hub.summarizeAsync()).toEqual(hub.summarize());
    expect(await hub.exportAsync("json")).toBe(hub.export("json"));
    await hub.flush();
    await hub.close();
  });

  it("pages the in-memory metrics with the same cursor contract as a store", async () => {
    const hub = createObservabilityHub();
    for (let index = 0; index < 5; index += 1) hub.record(metric({ amount: String(index) }));
    const first = await hub.queryMetrics({}, { limit: 2 });
    expect(first.metrics.map((m) => m.amount)).toEqual(["0", "1"]);
    const second = await hub.queryMetrics({}, { limit: 2, cursor: first.nextCursor });
    expect(second.metrics.map((m) => m.amount)).toEqual(["2", "3"]);
    const last = await hub.queryMetrics({}, { limit: 2, cursor: second.nextCursor });
    expect(last.metrics.map((m) => m.amount)).toEqual(["4"]);
    expect(last.nextCursor).toBeUndefined();
  });
});
