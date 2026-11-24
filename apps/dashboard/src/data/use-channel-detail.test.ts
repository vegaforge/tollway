import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useChannelDetail } from "./use-channel-detail";

describe("useChannelDetail", () => {
  it("starts loading and settles to ready for a tracked channel", async () => {
    const { result } = renderHook(() => useChannelDetail("ch-openai-03"));

    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    if (result.current.status !== "ready") throw new Error("expected ready state");
    expect(result.current.detail.channel.id).toBe("ch-openai-03");
  });

  it("settles to not-found, not error, for an unknown channel", async () => {
    const { result } = renderHook(() => useChannelDetail("ch-unknown"));

    await waitFor(() => {
      expect(result.current.status).toBe("not-found");
    });
  });

  it("loads the new channel when the id changes", async () => {
    const { result, rerender } = renderHook(({ id }) => useChannelDetail(id), {
      initialProps: { id: "ch-openai-03" },
    });
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    rerender({ id: "ch-unknown" });

    await waitFor(() => {
      expect(result.current.status).toBe("not-found");
    });
  });
});
