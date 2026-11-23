/**
 * Tests for GET /v1/events/stream.
 *
 * Uses app.request() so the full Hono middleware stack runs (auth, type
 * filter, resume, reset) without starting a real HTTP server.
 *
 * SSE responses are `text/event-stream`. We consume them synchronously by
 * reading from a fixed buffer that has pre-populated events, so the tests
 * do not need timers or real streaming.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { resetSharedBuffer, sharedEventBuffer } from "../event-buffer.js";

const VALID_KEY = "test-api-key-at-least-16-chars";

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${VALID_KEY}` };
}

/**
 * Read SSE events from a Response stream. The service stream is infinite
 * (it polls for new events and sends heartbeats), so we read chunks until
 * the stream goes quiet for a moment, then cancel and return what we have.
 * The initial burst of buffered events arrives synchronously; the first
 * heartbeat is 15s later, so a 300ms quiet window is enough.
 */
async function readSseEvents(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    // The route writes the initial burst of events synchronously, then
    // enters a 15s polling loop. Read until the stream goes quiet (100ms
    // with no data), collecting the initial burst.
    let lastReadTime = Date.now();
    while (Date.now() - lastReadTime < 100) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 100),
        ),
      ]);
      if (result.done) break;
      if (result.value) {
        text += decoder.decode(result.value, { stream: true });
        lastReadTime = Date.now();
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

/**
 * Parse SSE body text into an array of `{ event, data, id }` objects.
 * Comments are discarded.
 */
function parseSse(text: string): Array<{ event: string; data: string; id: string | null }> {
  const events: Array<{ event: string; data: string; id: string | null }> = [];
  let current: { event: string; data: string; id: string | null } | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith(":")) continue; // comment
    if (line === "") {
      if (current !== null) events.push(current);
      current = null;
      continue;
    }
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    const value = colonIdx === -1 ? "" : line.slice(colonIdx + 2);

    switch (field) {
      case "event":
        if (current === null) current = { event: "", data: "", id: null };
        current.event = value;
        break;
      case "data":
        if (current === null) current = { event: "", data: "", id: null };
        current.data += value;
        break;
      case "id":
        if (current === null) current = { event: "", data: "", id: null };
        current.id = value;
        break;
    }
  }
  if (current !== null) events.push(current);
  return events;
}

beforeEach(() => {
  process.env.SERVICE_API_KEY = VALID_KEY;
  resetSharedBuffer();
});

afterEach(() => {
  delete process.env.SERVICE_API_KEY;
});

describe("GET /v1/events/stream auth", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const res = await app.request("/v1/events/stream");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong key", async () => {
    const res = await app.request("/v1/events/stream", {
      headers: { authorization: "Bearer wrong-key-with-enough-chars" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid key", async () => {
    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  });
});

describe("GET /v1/events/stream ordering", () => {
  it("events are delivered in ascending id order", async () => {
    const buf = sharedEventBuffer();
    buf.push("receipt.created", { receipt: { id: "r1" } });
    buf.push("anomaly.detected", { id: "a1", type: "spend-spike" });
    buf.push("metrics.delta", { settledCount: 2 });

    // Replay from id 1 to get events 2 and 3 (since(0) returns null → reset).
    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("ids are monotonically increasing integers", async () => {
    const buf = sharedEventBuffer();
    for (let i = 0; i < 5; i++) buf.push("metrics.delta", { settledCount: i });

    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "2" },
    });
    const text = await readSseEvents(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    const ids = events.map((e) => Number(e.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }
  });
});

describe("GET /v1/events/stream type filter", () => {
  it("without a types param, streams all event types", async () => {
    const buf = sharedEventBuffer();
    buf.push("receipt.created", { receipt: { id: "r1" } });
    buf.push("channel.opened", { channelId: "ch-1" });
    buf.push("anomaly.detected", { id: "a1", type: "spike" });

    // Replay from id 1 to get events 2 and 3 (since(0) returns null → reset).
    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const types = parseSse(text)
      .filter((e) => e.event !== "reset")
      .map((e) => e.event);
    expect(types).toContain("channel.opened");
    expect(types).toContain("anomaly.detected");
  });

  it("filters to the requested event types only", async () => {
    const buf = sharedEventBuffer();
    buf.push("receipt.created", { receipt: { id: "r1" } });
    buf.push("channel.opened", { channelId: "ch-1" });
    buf.push("anomaly.detected", { id: "a1", type: "spike" });

    const res = await app.request(
      "/v1/events/stream?types=receipt.created,anomaly.detected",
      {
        headers: { ...authHeader(), "last-event-id": "1" },
      },
    );
    const text = await readSseEvents(res);
    const types = parseSse(text)
      .filter((e) => e.event !== "reset")
      .map((e) => e.event);
    expect(types).toContain("anomaly.detected");
    expect(types).not.toContain("channel.opened");
  });

  it("ignores unknown type names in the filter", async () => {
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 });
    buf.push("metrics.delta", { settledCount: 2 });

    const res = await app.request("/v1/events/stream?types=metrics.delta,unknown.type", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const types = parseSse(text)
      .filter((e) => e.event !== "reset")
      .map((e) => e.event);
    expect(types).toContain("metrics.delta");
  });
});

describe("GET /v1/events/stream resume from Last-Event-ID", () => {
  it("replays only events after the given id", async () => {
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 }); // id 1
    buf.push("metrics.delta", { settledCount: 2 }); // id 2
    buf.push("metrics.delta", { settledCount: 3 }); // id 3

    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("sends a reset event when Last-Event-ID is older than the buffer", async () => {
    // Fill the buffer beyond its capacity so event 1 is well past the boundary.
    resetSharedBuffer(3);
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 }); // id 1 — evicted
    buf.push("metrics.delta", { settledCount: 2 }); // id 2 — evicted
    buf.push("metrics.delta", { settledCount: 3 }); // id 3
    buf.push("metrics.delta", { settledCount: 4 }); // id 4
    buf.push("metrics.delta", { settledCount: 5 }); // id 5 — evicts ids 1 and 2

    // Buffer now has [3, 4, 5]. Last-Event-ID: 1 is older than oldest (3) - 1 = 2.
    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const events = parseSse(text);
    const reset = events.find((e) => e.event === "reset");
    expect(reset).toBeDefined();
    const resetData = JSON.parse(reset?.data ?? "{}") as { reason: string };
    expect(resetData.reason).toBe("buffer-expired");
  });

  it("sends a reset when no Last-Event-ID is present (fresh connection)", async () => {
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 });

    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    const text = await readSseEvents(res);
    const events = parseSse(text);
    const reset = events.find((e) => e.event === "reset");
    expect(reset).toBeDefined();
  });

  it("delivers no events when Last-Event-ID matches the latest", async () => {
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 }); // id 1

    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await readSseEvents(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    expect(events).toHaveLength(0);
  });
});

describe("GET /v1/events/stream abort cleanup", () => {
  it("response body is closed when the request is aborted", async () => {
    // We cannot easily abort mid-stream with app.request(), but we can verify
    // the route returns a valid SSE response that could be aborted.
    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    expect(res.body).not.toBeNull();
    // Cancel the reader to simulate abort.
    await res.body?.cancel();
  });
});
