import { describe, it, expect } from "vitest";
import { formatPrometheusMetrics } from "./prometheus-exporter.js";
import type { PaymentMetric } from "./index.js";

describe("Prometheus exporter", () => {
  it("formats metrics in Prometheus text format", () => {
    const metrics: PaymentMetric[] = [
      {
        payer: "alice",
        payee: "bob",
        model: "x402",
        amount: "1000",
        asset: "USDC",
        latencyMs: 100,
        outcome: "settled",
        at: "2026-11-24T10:00:00Z",
      },
      {
        payer: "alice",
        payee: "bob",
        model: "x402",
        amount: "2000",
        asset: "USDC",
        latencyMs: 150,
        outcome: "settled",
        at: "2026-11-24T10:01:00Z",
      },
    ];

    const output = formatPrometheusMetrics(metrics);
    expect(output).toContain("tollway_settlements_total");
    expect(output).toContain("tollway_payer_spend_total");
    expect(output).toContain("tollway_payee_spend_total");
    expect(output).toContain("HELP");
    expect(output).toContain("TYPE");
  });

  it("includes latency percentiles", () => {
    const metrics: PaymentMetric[] = Array.from({ length: 100 }, (_, i) => ({
      payer: "alice",
      payee: "bob",
      model: "x402",
      amount: "1000",
      asset: "USDC",
      latencyMs: i * 10,
      outcome: "settled",
      at: `2026-11-24T10:00:${String(i).padStart(2, "0")}Z`,
    }));

    const output = formatPrometheusMetrics(metrics);
    expect(output).toContain("tollway_settlement_latency_ms_p50");
    expect(output).toContain("tollway_settlement_latency_ms_p95");
    expect(output).toContain("tollway_settlement_latency_ms_p99");
  });

  it("supports custom prefix", () => {
    const metrics: PaymentMetric[] = [
      {
        payer: "alice",
        payee: "bob",
        model: "x402",
        amount: "1000",
        asset: "USDC",
        latencyMs: 100,
        outcome: "settled",
        at: "2026-11-24T10:00:00Z",
      },
    ];

    const output = formatPrometheusMetrics(metrics, { prefix: "custom" });
    expect(output).toContain("custom_tollway_settlements_total");
  });

  it("escapes label values", () => {
    const metrics: PaymentMetric[] = [
      {
        payer: 'alice"test',
        payee: "bob\\escaped",
        model: "x402",
        amount: "1000",
        asset: "USDC",
        latencyMs: 100,
        outcome: "settled",
        at: "2026-11-24T10:00:00Z",
      },
    ];

    const output = formatPrometheusMetrics(metrics);
    expect(output).toContain('\\"');
    expect(output).toContain("\\\\");
  });
});
