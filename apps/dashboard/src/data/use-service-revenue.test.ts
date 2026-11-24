import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceRevenueRow } from "./service-revenue";

const failure = vi.hoisted(() => ({ error: undefined as Error | undefined }));

// The real source runs unless a test sets `failure.error`.
vi.mock("./service-revenue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-revenue")>();
  return {
    ...actual,
    fetchServiceRevenue: () =>
      failure.error ? Promise.reject(failure.error) : actual.fetchServiceRevenue(),
  };
});

import { useServiceRevenue } from "./use-service-revenue";

function hasRequiredKeys(row: ServiceRevenueRow): boolean {
  return (
    typeof row.id === "string" &&
    typeof row.payee === "string" &&
    typeof row.label === "string" &&
    typeof row.asset === "string" &&
    typeof row.revenue === "string" &&
    typeof row.count === "number" &&
    Array.isArray(row.models)
  );
}

afterEach(() => {
  failure.error = undefined;
});

describe("useServiceRevenue", () => {
  it("starts in the loading state and settles to ready with the typed row shape", async () => {
    const { result } = renderHook(() => useServiceRevenue());

    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("expected ready state");
    }
    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.rows.every(hasRequiredKeys)).toBe(true);
  });

  it("returns revenue as integer strings parseable as BigInt", async () => {
    const { result } = renderHook(() => useServiceRevenue());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("expected ready state");
    }
    for (const row of result.current.rows) {
      expect(() => BigInt(row.revenue)).not.toThrow();
    }
  });

  it("surfaces a failing source as the error state", async () => {
    failure.error = new Error("hub offline");

    const { result } = renderHook(() => useServiceRevenue());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") throw new Error("expected error state");
    expect(result.current.error.message).toBe("hub offline");
  });
});
