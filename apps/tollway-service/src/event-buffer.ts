/**
 * Bounded in-memory event retention buffer.
 *
 * Every event emitted by the service is appended here with a monotonically
 * increasing integer id. Reconnecting clients send `Last-Event-ID`; the
 * buffer replays every event after that id. When the requested id is older
 * than the buffer (or is "0" / absent) the stream opens with a `reset` event
 * so the client refetches snapshots instead of silently skipping events.
 *
 * The buffer is a single-process in-memory store. With multiple service
 * replicas, ids are only monotonic within one replica, so a client may
 * reconnect to a different replica and receive a `reset`. Docs record this
 * limitation; a Redis Streams–backed implementation would fix it.
 *
 * See docs/dashboard-data-contracts.md, "Stream ordering and resume".
 */

import type { SseEventType } from "./event-schemas.js";

export type BufferedEvent = {
  /** Monotonically increasing, 1-indexed. */
  id: number;
  type: SseEventType;
  /** Pre-serialised JSON string; the SSE `data:` line. */
  data: string;
};

/** Default maximum number of events retained. */
export const DEFAULT_BUFFER_CAPACITY = 1_000;

export class EventBuffer {
  private readonly capacity: number;
  private readonly events: BufferedEvent[] = [];
  private nextId = 1;

  constructor(capacity = DEFAULT_BUFFER_CAPACITY) {
    this.capacity = capacity;
  }

  /** Append an event and return its assigned id. */
  push(type: SseEventType, data: unknown): number {
    const id = this.nextId++;
    this.events.push({ id, type, data: JSON.stringify(data) });
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
    return id;
  }

  /**
   * All events with id > `afterId`, in order.
   * Returns `null` when `afterId` is older than the buffer's oldest event
   * (the caller should send a `reset` instead of a replay).
   */
  since(afterId: number): BufferedEvent[] | null {
    if (afterId === 0) return null;
    const oldest = this.events[0];
    if (oldest === undefined) return [];
    // If the client asks for an id older than what the buffer holds, it has
    // missed events we cannot replay.
    if (afterId < oldest.id - 1) return null;
    return this.events.filter((e) => e.id > afterId);
  }

  /** Every buffered event, oldest first, for a fresh connection to replay. */
  all(): BufferedEvent[] {
    return [...this.events];
  }

  /** The id of the most recently appended event, or 0 when empty. */
  get latestId(): number {
    return this.nextId - 1;
  }

  /** Number of events currently retained. */
  get size(): number {
    return this.events.length;
  }
}

/** Singleton buffer for the process. Tests can inject their own instance. */
let _sharedBuffer: EventBuffer | null = null;

export function sharedEventBuffer(): EventBuffer {
  if (_sharedBuffer === null) {
    _sharedBuffer = new EventBuffer();
  }
  return _sharedBuffer;
}

/** Replace the shared buffer: test use only. */
export function resetSharedBuffer(capacity?: number): void {
  _sharedBuffer = new EventBuffer(capacity);
}
