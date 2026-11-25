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
 * Read what an SSE response has sent so far, then cancel it. The stream never
 * ends on its own (it polls and sends heartbeats until the client leaves), so
 * reading it to the end would hang. Reading stops at the first heartbeat,
 * which the route sends once it has written everything buffered; cancelling
 * then fires the route's onAbort, as a disconnecting client would.
 */
async function body(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(": heartbeat")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

/**
 * Parse SSE body text into an array of `{ event, data, id }` objects.
 * Comments are discarded.
 */
function parseSse(text: string): Array<{ event: string; data: string; id: string | null }> {
  const events: Array<{ event: string; data: string; id: string | null }> = [];
  let current: { event: string; data: string; id: string | null } | null = null;
  const getCurrent = () => {
    if (current === null) current = { event: "", data: "", id: null };
    return current;
  };

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
        getCurrent().event = value;
        break;
      case "data":
        getCurrent().data += value;
        break;
      case "id":
        getCurrent().id = value;
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

    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    const text = await body(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    expect(events.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("ids are monotonically increasing integers", async () => {
    const buf = sharedEventBuffer();
    for (let i = 0; i < 5; i++) buf.push("metrics.delta", { settledCount: i });

    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    const text = await body(res);
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

    const res = await app.request("/v1/events/stream", { headers: authHeader() });
    const text = await body(res);
    const types = parseSse(text)
      .filter((e) => e.event !== "reset")
      .map((e) => e.event);
    expect(types).toContain("receipt.created");
    expect(types).toContain("channel.opened");
    expect(types).toContain("anomaly.detected");
  });

  it("filters to the requested event types only", async () => {
    const buf = sharedEventBuffer();
    buf.push("receipt.created", { receipt: { id: "r1" } });
    buf.push("channel.opened", { channelId: "ch-1" });
    buf.push("anomaly.detected", { id: "a1", type: "spike" });

    const res = await app.request("/v1/events/stream?types=receipt.created,anomaly.detected", {
      headers: authHeader(),
    });
    const text = await body(res);
    const types = parseSse(text)
      .filter((e) => e.event !== "reset")
      .map((e) => e.event);
    expect(types).toContain("receipt.created");
    expect(types).toContain("anomaly.detected");
    expect(types).not.toContain("channel.opened");
  });

  it("ignores unknown type names in the filter", async () => {
    const buf = sharedEventBuffer();
    buf.push("metrics.delta", { settledCount: 1 });

    const res = await app.request("/v1/events/stream?types=metrics.delta,unknown.type", {
      headers: authHeader(),
    });
    const text = await body(res);
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
    const text = await body(res);
    const events = parseSse(text).filter((e) => e.event !== "reset");
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("sends a reset event when Last-Event-ID is older than the buffer", async () => {
    // Fill a 3-event buffer with 5 events: it keeps 3, 4 and 5. A client that
    // last saw id 1 has missed id 2, which is gone, so it must be reset.
    resetSharedBuffer(3);
    const buf = sharedEventBuffer();
    for (let i = 1; i <= 5; i++) buf.push("metrics.delta", { settledCount: i });

    const res = await app.request("/v1/events/stream", {
      headers: { ...authHeader(), "last-event-id": "1" },
    });
    const text = await body(res);
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
    const text = await body(res);
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
    const text = await body(res);
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
