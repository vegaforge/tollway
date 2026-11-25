/**
 * Tests for useEventStream and the hooks that consume it.
 *
 * We use a fake EventSource that exposes a fluent API for dispatching events
 * synchronously in tests. The hook is tested via the behaviour of the
 * consuming hooks (useOpenChannels) rather than in isolation,
 * because the interesting behaviour is in the state merging and deduplication.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandlerMap, useEventStream } from "./use-event-stream";

// Live updates are opt-in (NEXT_PUBLIC_LIVE_UPDATES); these tests exercise
// the stream, so they switch it on before the hook module loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_LIVE_UPDATES = "true";
});

// ---------------------------------------------------------------------------
// Fake EventSource
// ---------------------------------------------------------------------------

type FakeListener = (event: MessageEvent | Event) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.OPEN;
  url: string;
  private listeners: Map<string, FakeListener[]> = new Map();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    // Dispatch open asynchronously like a real EventSource.
    queueMicrotask(() => this.dispatch("open", new Event("open")));
  }

  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  static latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error("No FakeEventSource instances");
    return last;
  }

  addEventListener(type: string, listener: FakeListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Dispatch a named SSE event with a data payload (JSON-stringified). */
  emit(eventType: string, data: unknown, lastEventId = "") {
    // lastEventId is read-only on MessageEvent, so it goes in the init dict.
    const event = new MessageEvent(eventType, { data: JSON.stringify(data), lastEventId });
    this.dispatch(eventType, event);
  }

  dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitError() {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatch("error", new Event("error"));
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  // Stub requestAnimationFrame to run callbacks synchronously.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// useEventStream status transitions
// ---------------------------------------------------------------------------

describe("useEventStream status", () => {
  it("starts in connecting and transitions to live when EventSource opens", async () => {
    const { result } = renderHook(() => {
      const handlersRef = useRef(createHandlerMap());
      return useEventStream({ handlersRef });
    });
    expect(result.current).toBe("connecting");

    await waitFor(() => expect(result.current).toBe("live"));
  });

  it("transitions to reconnecting when EventSource closes after an error", async () => {
    const { result } = renderHook(() => {
      const handlersRef = useRef(createHandlerMap());
      return useEventStream({ handlersRef });
    });
    await waitFor(() => expect(result.current).toBe("live"));

    act(() => {
      FakeEventSource.latest().emitError();
    });

    expect(result.current).toBe("reconnecting");
  });

  it("is paused when enabled is false", () => {
    const { result } = renderHook(() => {
      const handlersRef = useRef(createHandlerMap());
      return useEventStream({ handlersRef, enabled: false });
    });
    expect(result.current).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useOpenChannels: in-place update
// ---------------------------------------------------------------------------

describe("useOpenChannels channel lifecycle events", () => {
  it("appends a new channel on channel.opened", async () => {
    const { useOpenChannels } = await import("./use-open-channels");
    const { result } = renderHook(() => useOpenChannels());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      FakeEventSource.latest().emit("channel.opened", {
        channelId: "ch-new-1",
        counterparty: "GNEW",
        deposit: "5000000000",
        asset: "USDC",
        openedAt: "2026-11-19T10:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows.some((r) => r.id === "ch-new-1")).toBe(true);
    });
  });

  it("does not duplicate a channel that is already in the list", async () => {
    const { useOpenChannels } = await import("./use-open-channels");
    const { result } = renderHook(() => useOpenChannels());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const initialCount = result.current.status === "ready" ? result.current.rows.length : 0;

    act(() => {
      // ch-stripe-01 is already in the stub snapshot.
      FakeEventSource.latest().emit("channel.opened", {
        channelId: "ch-stripe-01",
        counterparty: "GCSTRIPE...XYZ",
        deposit: "5000000000",
        asset: "USDC",
        openedAt: "2026-11-19T10:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(initialCount);
    });
  });

  it("sets status to closed on channel.closed", async () => {
    const { useOpenChannels } = await import("./use-open-channels");
    const { result } = renderHook(() => useOpenChannels());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      FakeEventSource.latest().emit("channel.closed", {
        channelId: "ch-stripe-01",
        counterparty: "GCSTRIPE...XYZ",
        settled: "1250000000",
        asset: "USDC",
        closedAt: "2026-11-19T12:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      const row = result.current.rows.find((r) => r.id === "ch-stripe-01");
      expect(row?.status).toBe("closed");
    });
  });
});

// ---------------------------------------------------------------------------
// Burst coalescing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Schema validation: invalid events are dropped silently
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reconnect status
// ---------------------------------------------------------------------------
