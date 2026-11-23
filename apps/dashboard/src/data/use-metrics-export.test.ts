import { renderHook, waitFor } from "@testing-library/react";
import type { PaymentMetric } from "@vegaforge/tollway-observability";
import { describe, expect, it } from "vitest";

import {
  buildExportFilename,
  buildMetricsQuery,
  isValidIsoDate,
  validateDateRange,
} from "./metrics-export";
import { useMetricsExport } from "./use-metrics-export";

describe("useMetricsExport", () => {
  it("starts in the loading state and settles to ready with an ObservabilityHub-shaped source", async () => {
    const { result } = renderHook(() => useMetricsExport());

    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("expected ready state");
    }

    const { hub, defaultFrom, defaultTo } = result.current;
    const query = buildMetricsQuery(defaultFrom, defaultTo);

    const parsed = JSON.parse(hub.export("json", query)) as PaymentMetric[];
    expect(parsed.length).toBeGreaterThan(0);
    for (const row of parsed) {
      expect(() => BigInt(row.amount)).not.toThrow();
    }

    const csvLines = hub.export("csv", query).split("\r\n");
    expect(csvLines[0]).toBe("payer,payee,model,amount,asset,latencyMs,outcome,at");
    expect(csvLines).toHaveLength(parsed.length + 1);
  });
});

describe("metrics export range and filename helpers", () => {
  it("validates ISO calendar dates", () => {
    expect(isValidIsoDate("2026-11-19")).toBe(true);
    expect(isValidIsoDate("2026-02-31")).toBe(false);
    expect(isValidIsoDate("2026/11/19")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });

  it("validates date ranges", () => {
    expect(validateDateRange("", "2026-11-19")).toBe("Select both a start date and an end date.");
    expect(validateDateRange("2026-11-13", "")).toBe("Select both a start date and an end date.");
    expect(validateDateRange("2026-02-31", "2026-11-19")).toBe(
      "Enter valid dates in YYYY-MM-DD format.",
    );
    expect(validateDateRange("2026-11-20", "2026-11-19")).toBe(
      "Start date must be on or before end date.",
    );
    expect(validateDateRange("2026-11-19", "2026-11-19")).toBeNull();
    expect(validateDateRange("2026-11-13", "2026-11-19")).toBeNull();
  });

  it("builds whole-day UTC queries and expected filenames", () => {
    expect(buildMetricsQuery("2026-11-13", "2026-11-19")).toEqual({
      from: "2026-11-13T00:00:00.000Z",
      to: "2026-11-19T23:59:59.999Z",
    });
    expect(buildExportFilename("2026-11-13", "2026-11-19", "json")).toBe(
      "tollway-metrics-2026-11-13-2026-11-19.json",
    );
    expect(buildExportFilename("2026-11-13", "2026-11-19", "csv")).toBe(
      "tollway-metrics-2026-11-13-2026-11-19.csv",
    );
  });
});
