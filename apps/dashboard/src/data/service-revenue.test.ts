import { createObservabilityHub, type PaymentMetric } from "@vegaforge/tollway-observability";
import { describe, expect, it } from "vitest";

import { fetchServiceRevenue, serviceRevenueFrom } from "./service-revenue";

// The hub treats both bounds as inclusive.
const PERIOD = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" };
const PAYEE_A = "GPAYEEAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const PAYEE_B = "GPAYEEBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function metric(overrides: Partial<PaymentMetric>): PaymentMetric {
  return {
    payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    payee: PAYEE_A,
    model: "x402",
    amount: "1000000",
    asset: "USDC",
    latencyMs: 100,
    outcome: "settled",
    at: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function hubWith(metrics: PaymentMetric[]) {
  const hub = createObservabilityHub();
  for (const m of metrics) hub.record(m);
  return hub;
}

describe("serviceRevenueFrom", () => {
  it("returns one row per payee and asset, never adding assets together", async () => {
    const hub = hubWith([
      metric({ payee: PAYEE_A, asset: "USDC", amount: "1000000" }),
      metric({ payee: PAYEE_A, asset: "XLM", amount: "5000000" }),
      metric({ payee: PAYEE_B, asset: "USDC", amount: "2000000" }),
    ]);

    const snapshot = await serviceRevenueFrom(hub, PERIOD, {});

    const keys = snapshot.rows.map((row) => `${row.payee}:${row.asset}`).sort();
    expect(keys).toEqual([`${PAYEE_A}:USDC`, `${PAYEE_A}:XLM`, `${PAYEE_B}:USDC`].sort());
    const usdcA = snapshot.rows.find((row) => row.payee === PAYEE_A && row.asset === "USDC");
    expect(usdcA?.revenue).toBe("1000000");
  });

  it("sums revenue with BigInt so amounts above 2^53 stay exact", async () => {
    const hub = hubWith([
      metric({ amount: "9007199254740993" }),
      metric({ amount: "9007199254740993" }),
    ]);

    const [row] = (await serviceRevenueFrom(hub, PERIOD, {})).rows;

    expect(row?.revenue).toBe("18014398509481986");
    expect(row?.count).toBe(2);
  });

  it("counts only settled payments toward revenue, count and the model mix", async () => {
    const hub = hubWith([
      metric({ model: "x402", outcome: "settled", amount: "100" }),
      metric({ model: "x402", outcome: "failed", amount: "100" }),
      metric({ model: "mpp-charge", outcome: "skipped", amount: "100" }),
    ]);

    const [row] = (await serviceRevenueFrom(hub, PERIOD, {})).rows;

    expect(row?.revenue).toBe("100");
    expect(row?.count).toBe(1);
    expect(row?.models.find((m) => m.model === "x402")?.count).toBe(1);
    expect(row?.models.find((m) => m.model === "mpp-charge")?.count).toBe(0);
  });

  it("lists every settlement model, with a null latency where a model has no settled payment", async () => {
    const hub = hubWith([metric({ model: "mpp-channel", latencyMs: 40 })]);

    const [row] = (await serviceRevenueFrom(hub, PERIOD, {})).rows;

    expect(row?.models.map((m) => m.model)).toEqual(["x402", "mpp-charge", "mpp-channel"]);
    expect(row?.models.find((m) => m.model === "x402")?.avgLatencyMs).toBeNull();
    expect(row?.models.find((m) => m.model === "mpp-channel")?.avgLatencyMs).toBe(40);
  });

  it("averages latency per model over settled payments only", async () => {
    const hub = hubWith([
      metric({ model: "x402", latencyMs: 100 }),
      metric({ model: "x402", latencyMs: 201 }),
      metric({ model: "x402", latencyMs: 9000, outcome: "failed" }),
    ]);

    const [row] = (await serviceRevenueFrom(hub, PERIOD, {})).rows;

    // (100 + 201) / 2 = 150.5, shown in whole milliseconds.
    expect(row?.models.find((m) => m.model === "x402")?.avgLatencyMs).toBe(151);
  });

  it("ignores payments outside the period", async () => {
    const hub = hubWith([
      metric({ at: "2026-10-31T23:59:59.000Z" }),
      metric({ at: "2026-12-01T00:00:00.000Z" }),
    ]);

    expect((await serviceRevenueFrom(hub, PERIOD, {})).rows).toEqual([]);
  });

  it("labels a known payee and falls back to the address for an unknown one", async () => {
    const hub = hubWith([metric({ payee: PAYEE_A }), metric({ payee: PAYEE_B })]);

    const { rows } = await serviceRevenueFrom(hub, PERIOD, { [PAYEE_A]: "Weather API" });

    expect(rows.find((row) => row.payee === PAYEE_A)?.label).toBe("Weather API");
    expect(rows.find((row) => row.payee === PAYEE_B)?.label).toBe(PAYEE_B);
  });

  it("returns no rows when nothing was recorded", async () => {
    expect((await serviceRevenueFrom(hubWith([]), PERIOD, {})).rows).toEqual([]);
  });
});

describe("fetchServiceRevenue", () => {
  it("is deterministic, so tests and the static build are stable", async () => {
    expect(await fetchServiceRevenue()).toEqual(await fetchServiceRevenue());
  });

  it("returns integer base-unit revenue strings", async () => {
    const { rows } = await fetchServiceRevenue();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.revenue).toMatch(/^[0-9]+$/);
    }
  });
});
