"use client";

/**
 * useEventStream
 *
 * Opens an EventSource to /api/events/stream (the Next.js SSE proxy) and
 * dispatches typed, Zod-validated events to registered handlers.
 *
 * Resume on reconnect
 *   EventSource automatically sends `Last-Event-ID` on reconnect; the
 *   proxy forwards it to the service, which replays missed events or sends
 *   a `reset` event when the buffer has expired.
 *
 * Connection status
 *   The hook returns a `StreamStatus`:
 *   - `connecting` – EventSource not yet OPEN.
 *   - `live`       – OPEN, receiving events.
 *   - `reconnecting` – CLOSED after an error; EventSource is retrying.
 *   - `paused`     – The browser or user paused the stream (e.g. page hidden).
 *
 * Burst coalescing
 *   Incoming events are queued and flushed into handlers in a single
 *   React render cycle via `requestAnimationFrame` (or `setTimeout` when
 *   rAF is unavailable). The queue is capped at MAX_QUEUE to prevent
 *   memory growth under a flood.
 *
 * Usage pattern
 *   Each data hook that wants to consume events:
 *   1. Creates its own `handlersRef` with `useRef<HandlerMap>(new Map())`.
 *   2. Registers event handlers via `registerSseHandler(handlersRef, type, fn)`.
 *   3. Calls `useEventStream({ handlersRef, types, onReset })` to open the stream.
 *
 *   This pattern lets multiple independent hooks share one EventSource by
 *   passing the same `handlersRef`. Each hook that opens its own stream
 *   with a different set of `types` gets its own EventSource.
 */

import { parseSseEvent, type SseEvent, type SseEventType } from "@/lib/event-schemas";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "paused";

export type HandlerMap = Map<SseEventType, Array<(event: SseEvent) => void>>;

/** Create an empty handler map for use with useRef in consuming hooks. */
export function createHandlerMap(): HandlerMap {
  return new Map();
}

export type UseEventStreamOptions = {
  /**
   * The shared handler map populated by `registerSseHandler`. The
   * EventSource dispatches to these handlers on each validated event.
   */
  handlersRef: MutableRefObject<HandlerMap>;
  /**
   * Event types to subscribe to. Passed as the `?types=` query parameter
   * to the proxy so filtering happens at the source. Omit for all types.
   */
  types?: SseEventType[];
  /**
   * Called when the service sends a `reset` event (buffer expired or fresh
   * connection). The caller should refetch its snapshot from the REST API
   * and discard any state accumulated from previous events.
   */
  onReset?: () => void;
  /** Whether to open the stream. Defaults to true. */
  enabled?: boolean;
  /**
   * Maximum number of events to buffer between animation frames. Events
   * beyond this cap are dropped (oldest first). Default: 500.
   */
  maxQueueSize?: number;
};

/** Maximum events queued between animation frames. Prevents OOM under floods. */
const DEFAULT_MAX_QUEUE = 500;

export function useEventStream(options: UseEventStreamOptions): StreamStatus {
  const {
    handlersRef,
    types,
    onReset,
    enabled = true,
    maxQueueSize = DEFAULT_MAX_QUEUE,
  } = options;

  const [status, setStatus] = useState<StreamStatus>("connecting");
  // Queue for coalescing bursts.
  const queueRef = useRef<SseEvent[]>([]);
  const flushScheduledRef = useRef(false);
  const onResetRef = useRef(onReset);

  useEffect(() => {
    onResetRef.current = onReset;
  }, [onReset]);

  // Flush the queued events into their handlers in one batch.
  const flush = useCallback(() => {
    flushScheduledRef.current = false;
    const events = queueRef.current.splice(0);
    for (const event of events) {
      if (event.type === "reset") {
        onResetRef.current?.();
        continue;
      }
      const handlers = handlersRef.current.get(event.type) ?? [];
      for (const handler of handlers) {
        handler(event);
      }
    }
  }, [handlersRef]);

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }, [flush]);

  // Stable string key so a new array reference with the same values doesn't
  // close and reopen the EventSource on every render.
  const typesKey = types ? [...types].sort().join(",") : "";

  useEffect(() => {
    if (!enabled) {
      setStatus("paused");
      return;
    }

    setStatus("connecting");

    // Build the URL from the stable key so the effect does not need `types`
    // as a dependency (array identity would change on every render).
    const url = typesKey
      ? `/api/events/stream?types=${encodeURIComponent(typesKey)}`
      : "/api/events/stream";
    const es = new EventSource(url);
    function handleOpen() {
      setStatus("live");
    }

    function handleError() {
      if (es.readyState === EventSource.CLOSED) {
        setStatus("reconnecting");
      }
    }

    function enqueue(eventType: string, rawData: string, id: string) {
      let parsed: SseEvent | null;
      try {
        parsed = parseSseEvent(eventType, rawData, id);
      } catch {
        // Unparseable JSON; drop the event.
        return;
      }
      if (parsed === null) return;

      // Cap the queue to prevent memory growth under a flood.
      if (queueRef.current.length >= maxQueueSize) {
        queueRef.current.shift();
      }
      queueRef.current.push(parsed);
      scheduleFlush();
    }

    es.addEventListener("open", handleOpen);
    es.addEventListener("error", handleError);

    // Register listeners for every known event type.
    const typedListeners = new Map<string, (e: MessageEvent) => void>();
    for (const t of [
      "receipt.created",
      "channel.opened",
      "channel.closed",
      "budget.warning",
      "anomaly.detected",
      "metrics.delta",
      "reset",
    ] as const) {
      const listener = (e: MessageEvent) => enqueue(t, e.data as string, e.lastEventId);
      typedListeners.set(t, listener);
      es.addEventListener(t, listener as EventListener);
    }

    return () => {
      es.removeEventListener("open", handleOpen);
      es.removeEventListener("error", handleError);
      for (const [t, listener] of typedListeners) {
        es.removeEventListener(t, listener as EventListener);
      }
      es.close();
    };
  }, [enabled, typesKey, scheduleFlush, maxQueueSize]);

  return status;
}

/**
 * Register a handler for one event type on a shared handler map.
 * Returns an unsubscribe function; call it in an effect cleanup.
 *
 * Example:
 *   const handlersRef = useRef<HandlerMap>(new Map());
 *   useEffect(() => {
 *     return registerSseHandler(handlersRef, "receipt.created", (event) => { ... });
 *   }, []);
 *   const status = useEventStream({ handlersRef, types: ["receipt.created"] });
 */
export function registerSseHandler<T extends SseEventType>(
  handlersRef: MutableRefObject<HandlerMap>,
  type: T,
  handler: (event: Extract<SseEvent, { type: T }>) => void,
): () => void {
  const existing = handlersRef.current.get(type) ?? [];
  const wrapped = handler as (event: SseEvent) => void;
  handlersRef.current.set(type, [...existing, wrapped]);
  return () => {
    const current = handlersRef.current.get(type) ?? [];
    handlersRef.current.set(
      type,
      current.filter((h) => h !== wrapped),
    );
  };
}
}
