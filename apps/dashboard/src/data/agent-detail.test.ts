import { describe, expect, it } from "vitest";

import {
  bucketSeries,
  percentageBasisPoints,
  type SettledMetric,
  seriesByAsset,
} from "./agent-detail";

function metric(overrides: Partial<SettledMetric> = {}): SettledMetric {
  return {
    payer: "GAGENT1",
    payee: "GSERVICE1",
    model: "x402",
    amount: "10000000",
    asset: "USDC",
    outcome: "settled",
    at: "2026-11-19T10:30:00.000Z",
    ...overrides,
  };
}

describe("percentageBasisPoints", () => {
  it("returns 0 when nothing is spent", () => {
    expect(percentageBasisPoints(0n, 10_000_000n)).toBe(0n);
  });

  it("returns 10000 at exactly the budget", () => {
    expect(percentageBasisPoints(10_000_000n, 10_000_000n)).toBe(10_000n);
  });

  it("returns more than 10000 when over budget", () => {
    expect(percentageBasisPoints(12_000_000n, 10_000_000n)).toBe(12_000n);
  });

  it("multiplies before dividing so small ratios keep precision", () => {
    expect(percentageBasisPoints(1n, 3n)).toBe(3333n);
  });

  it("keeps precision on very large base-unit values", () => {
    expect(percentageBasisPoints(12_345_678_901_234_567_890n, 99_999_999_999_999_999_999n)).toBe(
      1234n,
    );
  });

  it("treats a zero budget with no spend as zero and any spend as fully consumed", () => {
    expect(percentageBasisPoints(0n, 0n)).toBe(0n);
    expect(percentageBasisPoints(1n, 0n)).toBe(10_000n);
  });
});

describe("bucketSeries", () => {
  it("sums settled payments in the same hour and keeps hours separate", () => {
    const points = bucketSeries(
      [
        metric({ amount: "100", at: "2026-11-19T10:05:00.000Z" }),
        metric({ amount: "250", at: "2026-11-19T10:55:00.000Z" }),
        metric({ amount: "400", at: "2026-11-19T11:05:00.000Z" }),
      ],
      "hour",
    );

    expect(points).toEqual([
      { bucket: "2026-11-19T10", amount: "350" },
      { bucket: "2026-11-19T11", amount: "400" },
    ]);
  });

  it("groups by UTC day and drops failed and skipped outcomes", () => {
    const points = bucketSeries(
      [
        metric({ amount: "100", at: "2026-11-19T23:59:00.000Z" }),
        metric({ amount: "200", at: "2026-11-20T00:01:00.000Z" }),
        metric({ amount: "999", outcome: "failed", at: "2026-11-20T00:02:00.000Z" }),
        metric({ amount: "999", outcome: "skipped", at: "2026-11-20T00:03:00.000Z" }),
      ],
      "day",
    );

    expect(points).toEqual([
      { bucket: "2026-11-19", amount: "100" },
      { bucket: "2026-11-20", amount: "200" },
    ]);
  });
});

describe("seriesByAsset", () => {
  it("keeps one series per asset and never mixes base units", () => {
    const series = seriesByAsset(
      [
        metric({ asset: "USDC", amount: "100", at: "2026-11-19T10:00:00.000Z" }),
        metric({ asset: "XLM", amount: "700", at: "2026-11-19T10:00:00.000Z" }),
        metric({ asset: "USDC", amount: "50", at: "2026-11-20T10:00:00.000Z" }),
      ],
      "day",
    );

    expect(series).toEqual([
      {
        asset: "USDC",
        points: [
          { bucket: "2026-11-19", amount: "100" },
          { bucket: "2026-11-20", amount: "50" },
        ],
      },
      {
        asset: "XLM",
        points: [{ bucket: "2026-11-19", amount: "700" }],
      },
    ]);
  });
});
