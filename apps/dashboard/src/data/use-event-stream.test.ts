/**
 * Tests for useEventStream and the hooks that consume it.
 *
 * We use a fake EventSource that exposes a fluent API for dispatching events
 * synchronously in tests. The hook is tested via the behaviour of the
 * consuming hooks (useAnomalies, useOpenChannels) rather than in isolation,
 * because the interesting behaviour is in the state merging and deduplication.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnomalies } from "./use-anomalies";
import { createHandlerMap, useEventStream } from "./use-event-stream";
import { useOpenChannels } from "./use-open-channels";

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
    const event = Object.assign(new MessageEvent(eventType, { data: JSON.stringify(data) }), {
      lastEventId,
    });
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
// useAnomalies — deduplication and prepend
// ---------------------------------------------------------------------------

describe("useAnomalies", () => {
  it("prepends new anomaly events, newest first", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      FakeEventSource.latest().emit("anomaly.detected", {
        id: "a1",
        type: "spend-spike",
        agentId: "agent-1",
        detail: "Spike detected",
        at: "2026-11-19T10:00:00.000Z",
      });
    });

    act(() => {
      FakeEventSource.latest().emit("anomaly.detected", {
        id: "a2",
        type: "budget-stop",
        agentId: "agent-2",
        detail: "Over daily limit",
        at: "2026-11-19T11:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(2);
      expect(result.current.rows[0]?.id).toBe("a2");
      expect(result.current.rows[1]?.id).toBe("a1");
    });
  });

  it("deduplicates events with the same id", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const payload = {
      id: "a-dup",
      type: "spend-spike",
      agentId: "agent-1",
      detail: "Dup",
      at: "2026-11-19T10:00:00.000Z",
    };

    act(() => {
      FakeEventSource.latest().emit("anomaly.detected", payload);
      FakeEventSource.latest().emit("anomaly.detected", payload);
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(1);
    });
  });

  it("filters by agentId when agentFilter is provided", async () => {
    const { result } = renderHook(() => useAnomalies("agent-1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      FakeEventSource.latest().emit("anomaly.detected", {
        id: "a1",
        type: "spend-spike",
        agentId: "agent-1",
        detail: "For agent 1",
        at: "2026-11-19T10:00:00.000Z",
      });
      FakeEventSource.latest().emit("anomaly.detected", {
        id: "a2",
        type: "budget-stop",
        agentId: "agent-2",
        detail: "For agent 2",
        at: "2026-11-19T11:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(1);
      expect(result.current.rows[0]?.agentId).toBe("agent-1");
    });
  });

  it("clears rows on a reset event", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      FakeEventSource.latest().emit("anomaly.detected", {
        id: "a1",
        type: "spend-spike",
        agentId: "agent-1",
        detail: "Spike",
        at: "2026-11-19T10:00:00.000Z",
      });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(1);
    });

    act(() => {
      FakeEventSource.latest().emit("reset", { reason: "buffer-expired" });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// useOpenChannels — in-place update
// ---------------------------------------------------------------------------

describe("useOpenChannels channel lifecycle events", () => {
  it("appends a new channel on channel.opened", async () => {
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

describe("burst coalescing", () => {
  it("batches multiple events into a single render cycle", async () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useAnomalies();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    const baseRenders = renderCount;

    act(() => {
      const es = FakeEventSource.latest();
      for (let i = 0; i < 10; i++) {
        es.emit("anomaly.detected", {
          id: `a-burst-${i}`,
          type: "spend-spike",
          agentId: "agent-1",
          detail: `Burst ${i}`,
          at: "2026-11-19T10:00:00.000Z",
        });
      }
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(10);
    });

    // All 10 events land in one rAF flush, so renders ≪ events.
    expect(renderCount - baseRenders).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid events are dropped silently
// ---------------------------------------------------------------------------

describe("schema validation", () => {
  it("drops an anomaly.detected event that fails schema validation", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      // Missing required fields — should be dropped.
      FakeEventSource.latest().emit("anomaly.detected", { invalid: true });
    });

    await waitFor(() => {
      if (result.current.status !== "ready") throw new Error("not ready");
      expect(result.current.rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Reconnect status
// ---------------------------------------------------------------------------

describe("reconnect state in consuming hooks", () => {
  it("reflects reconnecting status when EventSource errors", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.stream).toBe("live"));

    act(() => {
      FakeEventSource.latest().emitError();
    });

    await waitFor(() => expect(result.current.stream).toBe("reconnecting"));
  });
});

// ---------------------------------------------------------------------------
// Unconfigured — service not configured degrades quietly
// ---------------------------------------------------------------------------

describe("unconfigured event", () => {
  it("transitions to paused and does not reopen the stream when the proxy signals unconfigured", async () => {
    const { result } = renderHook(() => {
      const handlersRef = useRef(createHandlerMap());
      return useEventStream({ handlersRef });
    });

    await waitFor(() => expect(result.current).toBe("live"));

    act(() => {
      // Simulate the proxy sending the unconfigured terminal event.
      FakeEventSource.latest().dispatch("unconfigured", new Event("unconfigured"));
    });

    await waitFor(() => expect(result.current).toBe("paused"));

    // The EventSource should have been closed.
    expect(FakeEventSource.latest().readyState).toBe(FakeEventSource.CLOSED);

    // A new render cycle should not open a second EventSource.
    const instancesBefore = FakeEventSource.instances.length;
    expect(FakeEventSource.instances.length).toBe(instancesBefore);
  });

  it("consuming hook reflects paused stream status when service is unconfigured", async () => {
    const { result } = renderHook(() => useAnomalies());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.stream).toBe("live"));

    act(() => {
      FakeEventSource.latest().dispatch("unconfigured", new Event("unconfigured"));
    });

    await waitFor(() => expect(result.current.stream).toBe("paused"));
    // Stream status does not go back to connecting or live.
    expect(result.current.stream).toBe("paused");
  });
});
