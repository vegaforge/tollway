import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OpenChannelRow } from "./open-channels";
import { useOpenChannels } from "./use-open-channels";

function hasRequiredKeys(row: OpenChannelRow): boolean {
  return (
    typeof row.id === "string" &&
    typeof row.counterparty === "string" &&
    typeof row.deposit === "string" &&
    typeof row.committed === "string" &&
    typeof row.sequence === "number" &&
    typeof row.status === "string" &&
    typeof row.asset === "string"
  );
}

describe("useOpenChannels", () => {
  it("starts in the loading state and settles to ready with the typed row shape", async () => {
    const { result } = renderHook(() => useOpenChannels());

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

  it("returns deposit and committed as integer strings parseable as BigInt", async () => {
    const { result } = renderHook(() => useOpenChannels());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("expected ready state");
    }
    for (const row of result.current.rows) {
      expect(() => BigInt(row.deposit)).not.toThrow();
      expect(() => BigInt(row.committed)).not.toThrow();
    }
  });
});
