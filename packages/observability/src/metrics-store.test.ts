import { describe, it, expect, afterEach } from "vitest";
import { createMemoryMetricsStore, createSqliteMetricsStore } from "./metrics-store.js";
import type { PaymentMetric } from "./index.js";

const sampleMetric: PaymentMetric = {
  payer: "alice",
  payee: "bob",
  model: "x402",
  amount: "1000",
  asset: "USDC",
  latencyMs: 150,
  outcome: "settled",
  at: "2026-11-24T10:00:00Z",
};

describe("Memory metrics store", () => {
  it("records and queries metrics", async () => {
    const store = createMemoryMetricsStore();
    await store.record(sampleMetric);
    const results = await store.query();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(sampleMetric);
  });

  it("filters by payer", async () => {
    const store = createMemoryMetricsStore();
    await store.record(sampleMetric);
    await store.record({
      ...sampleMetric,
      payer: "charlie",
    });
    const results = await store.query({ payer: "alice" });
    expect(results).toHaveLength(1);
    expect(results[0].payer).toBe("alice");
  });

  it("filters by time range", async () => {
    const store = createMemoryMetricsStore();
    await store.record({
      ...sampleMetric,
      at: "2026-11-24T09:00:00Z",
    });
    await store.record({
      ...sampleMetric,
      at: "2026-11-24T10:00:00Z",
    });
    const results = await store.query({
      from: "2026-11-24T09:30:00Z",
      to: "2026-11-24T10:30:00Z",
    });
    expect(results).toHaveLength(1);
  });

  it("purges old records", async () => {
    const store = createMemoryMetricsStore();
    await store.record(sampleMetric);
    const purged = await store.purge(Date.now());
    expect(purged).toBeGreaterThan(0);
  });
});

describe("SQLite metrics store", () => {
  let store: ReturnType<typeof createSqliteMetricsStore>;

  afterEach(() => {
    store?.close();
  });

  it("records and queries metrics", async () => {
    store = createSqliteMetricsStore({ filename: ":memory:" });
    await store.record(sampleMetric);
    const results = await store.query();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].payer).toBe("alice");
  });

  it("supports concurrent writes", async () => {
    store = createSqliteMetricsStore({ filename: ":memory:" });
    const promises = Array.from({ length: 10 }, (_, i) =>
      store.record({
        ...sampleMetric,
        payer: `payer-${i}`,
      }),
    );
    await Promise.all(promises);
    const results = await store.query();
    expect(results.length).toBe(10);
  });
});
