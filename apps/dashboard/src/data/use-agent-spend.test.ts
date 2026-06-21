import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentSpendRow } from "./agent-spend";
import { useAgentSpend } from "./use-agent-spend";

function hasRequiredKeys(row: AgentSpendRow): boolean {
  return (
    typeof row.id === "string" &&
    typeof row.label === "string" &&
    typeof row.spend === "string" &&
    typeof row.budget === "string" &&
    typeof row.asset === "string"
  );
}

describe("useAgentSpend", () => {
  it("starts in the loading state and settles to ready with the typed row shape", async () => {
    const { result } = renderHook(() => useAgentSpend());

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

  it("returns spend and budget as integer strings parseable as BigInt", async () => {
    const { result } = renderHook(() => useAgentSpend());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("expected ready state");
    }
    for (const row of result.current.rows) {
      expect(() => BigInt(row.spend)).not.toThrow();
      expect(() => BigInt(row.budget)).not.toThrow();
    }
  });
});
