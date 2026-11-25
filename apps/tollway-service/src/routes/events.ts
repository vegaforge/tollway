/**
 * GET /v1/events/stream
 *
 * Streams typed SSE events to dashboard clients. Requires the `read` scope.
 *
 * Query parameters
 *   types  Comma-separated list of event types to include. Omit for all.
 *          Example: ?types=receipt.created,channel.opened
 *
 * Resume
 *   Send `Last-Event-ID: <n>` to replay events after id `n`. If `n` is
 *   older than the buffer's oldest retained event the server sends a
 *   `reset` event and the client must refetch snapshots.
 *
 * Heartbeat
 *   A comment line (`: heartbeat`) is sent every 15 seconds to keep the
 *   connection alive through proxies.
 *
 * The stream ends when the client disconnects; the server frees the
 * AbortController on the `onAbort` hook.
 *
 * Ordering note
 *   IDs are monotonic within one process. With multiple service replicas
 *   the ids are not globally ordered; see docs/dashboard-data-contracts.md,
 *   "Stream ordering and resume".
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireApiKey } from "../auth.js";
import { sharedEventBuffer } from "../event-buffer.js";
import { filterableEventTypes, type SseEventType } from "../event-schemas.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

const eventsRouter = new Hono();

eventsRouter.get("/stream", requireApiKey("read"), async (c) => {
  // Parse the optional type filter from the query string.
  const typesParam = c.req.query("types");
  const filter = parseTypeFilter(typesParam);

  // Resume from Last-Event-ID if present and parseable.
  const lastEventIdHeader = c.req.header("last-event-id");
  const afterId = parseLastEventId(lastEventIdHeader);

  const buffer = sharedEventBuffer();

  return streamSSE(c, async (stream) => {
    // On abort, free any resources. hono/streaming calls onAbort when the
    // client disconnects. The stream itself is closed by returning.
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    // Resume or reset.
    if (afterId !== null) {
      const missed = buffer.since(afterId);
      if (missed === null) {
        // The requested id is older than the buffer; tell the client to
        // refetch and start fresh.
        await stream.writeSSE({
          event: "reset",
          data: JSON.stringify({ reason: "buffer-expired" }),
          id: String(buffer.latestId),
        });
        if (aborted) return;
      } else {
        for (const event of missed) {
          if (aborted) return;
          if (filter !== null && !filter.has(event.type)) continue;
          await stream.writeSSE({
            event: event.type,
            data: event.data,
            id: String(event.id),
          });
        }
      }
    } else {
      // No Last-Event-ID: open stream, optionally send initial reset so the
      // client knows to treat this as a fresh start.
      await stream.writeSSE({
        event: "reset",
        data: JSON.stringify({ reason: "filter-changed" }),
        id: String(buffer.latestId),
      });
      if (aborted) return;
      // Then everything still buffered, so a new client starts with the
      // recent events instead of an empty feed.
      for (const event of buffer.all()) {
        if (aborted) return;
        if (filter !== null && !filter.has(event.type)) continue;
        await stream.writeSSE({ event: event.type, data: event.data, id: String(event.id) });
      }
    }

    // Track the highest id we have delivered so far.
    let highestDelivered = buffer.latestId;

    // Poll for new events and send heartbeats.
    while (!aborted) {
      const missed = buffer.since(highestDelivered);
      if (missed !== null && missed.length > 0) {
        for (const event of missed) {
          if (aborted) return;
          if (filter !== null && !filter.has(event.type)) continue;
          await stream.writeSSE({
            event: event.type,
            data: event.data,
            id: String(event.id),
          });
          highestDelivered = event.id;
        }
      } else if (missed !== null) {
        // No new events; send a heartbeat comment to keep the connection alive.
        // Hono's streamSSE wraps the stream; we write the raw SSE comment line.
        await stream.write(": heartbeat\n\n");
      }

      if (aborted) return;
      await stream.sleep(HEARTBEAT_INTERVAL_MS);
    }
  });
});

function parseTypeFilter(param: string | undefined): Set<SseEventType> | null {
  if (!param || param.trim().length === 0) return null;
  const requested = param.split(",").map((s) => s.trim());
  const valid = new Set<SseEventType>();
  for (const t of requested) {
    if ((filterableEventTypes as readonly string[]).includes(t)) {
      valid.add(t as SseEventType);
    }
  }
  return valid.size > 0 ? valid : null;
}

function parseLastEventId(header: string | undefined): number | null {
  if (!header) return null;
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export { eventsRouter };
