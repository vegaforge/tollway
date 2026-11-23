/**
 * The durable webhook outbox: one row per delivery, claimed with a lease,
 * retried with backoff, and kept for replay after it dead-letters.
 *
 * Rows store the subscription id and the event, never the subscription secret
 * or headers. The dispatcher resolves the subscription again at send time, so
 * a restart needs the same subscriptions registered, but no secret is ever
 * written to disk. See docs/webhook-delivery.md.
 */

import {
  isWebhookEvent,
  type TollwayEvent,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
} from "./events.js";

export { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_EVENT_ID_HEADER };

const randomUUID = () => globalThis.crypto.randomUUID();

export type WebhookDeliveryStatus = "pending" | "delivered" | "dead-letter";

/** One persisted attempt to POST one event to one subscription. */
export type WebhookDelivery = {
  /** Per-delivery id, new on every enqueue and replay. Receivers dedupe on it. */
  id: string;
  /** `TollwayEvent.id`, stable across every delivery of the same event. */
  eventId: string;
  subscriptionId: string;
  event: TollwayEvent;
  status: WebhookDeliveryStatus;
  /** Attempts that already finished, whether they succeeded or failed. */
  attempts: number;
  /** Epoch milliseconds before which the dispatcher must not claim the row. */
  nextAttemptAt: number;
  /** Epoch milliseconds; set while a dispatcher holds the row. */
  leaseExpiresAt: number | null;
  /** Last failure message. Never contains headers or the secret. */
  lastError: string | null;
  createdAt: number;
};

/** What `emit` hands the outbox: the delivery row is built by the store. */
export type NewWebhookDelivery = {
  subscriptionId: string;
  event: TollwayEvent;
};

/**
 * Persistence boundary for webhook deliveries. Every method may reject; the
 * dispatcher treats a rejected claim as a failed pass and retries next tick.
 */
export interface WebhookOutbox {
  /** Writes one pending row per delivery, due immediately. */
  enqueue(deliveries: readonly NewWebhookDelivery[]): Promise<void>;
  /**
   * Atomically takes up to `batch` due, unleased rows and leases them for
   * `leaseMs`. Two concurrent claimants never receive the same row.
   * `now` defaults to `Date.now()`.
   */
  claim(batch: number, leaseMs: number, now?: number): Promise<WebhookDelivery[]>;
  markDelivered(deliveryId: string): Promise<void>;
  /** Records a failed attempt and the next time the row is due. */
  markFailed(deliveryId: string, nextAttemptAt: number, error: string): Promise<void>;
  deadLetter(deliveryId: string, error: string): Promise<void>;
  /** Dead-letter rows, oldest first. */
  listDeadLetters(): Promise<WebhookDelivery[]>;
  /**
   * Re-enqueues a dead-letter row as a new pending delivery with attempts
   * reset and a fresh delivery id. Returns the new row. Throws when the id is
   * unknown or the row is not dead-lettered.
   */
  replay(deliveryId: string): Promise<WebhookDelivery>;
  /**
   * Drops a lease without counting an attempt, so another dispatcher can
   * claim the row immediately. Called when a dispatcher stops with work in
   * flight.
   */
  release(deliveryId: string): Promise<void>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function newDelivery(input: NewWebhookDelivery, now: number): WebhookDelivery {
  return {
    id: randomUUID(),
    eventId: input.event.id,
    subscriptionId: input.subscriptionId,
    event: input.event,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: now,
  };
}

function cloneDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return { ...delivery, event: { ...delivery.event } };
}

/** In-process outbox. Rows disappear with the process. */
export function createMemoryWebhookOutbox(): WebhookOutbox {
  const rows = new Map<string, WebhookDelivery>();

  return {
    async enqueue(deliveries) {
      const now = Date.now();
      for (const input of deliveries) {
        const delivery = newDelivery(input, now);
        rows.set(delivery.id, delivery);
      }
    },
    async claim(batch, leaseMs, now = Date.now()) {
      assertPositiveInteger(batch, "batch");
      assertPositiveInteger(leaseMs, "leaseMs");
      // No awaits between picking a row and leasing it, so the pass is atomic
      // within this process.
      const due = [...rows.values()]
        .filter(
          (row) =>
            row.status === "pending" &&
            row.nextAttemptAt <= now &&
            (row.leaseExpiresAt === null || row.leaseExpiresAt <= now),
        )
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
        .slice(0, batch);
      for (const row of due) {
        row.leaseExpiresAt = now + leaseMs;
      }
      return due.map(cloneDelivery);
    },
    async markDelivered(deliveryId) {
      const row = requireRow(rows, deliveryId);
      row.status = "delivered";
      row.leaseExpiresAt = null;
      row.lastError = null;
    },
    async markFailed(deliveryId, nextAttemptAt, error) {
      assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
      const row = requireRow(rows, deliveryId);
      row.attempts += 1;
      row.nextAttemptAt = nextAttemptAt;
      row.leaseExpiresAt = null;
      row.lastError = error;
    },
    async deadLetter(deliveryId, error) {
      const row = requireRow(rows, deliveryId);
      row.status = "dead-letter";
      row.leaseExpiresAt = null;
      row.lastError = error;
    },
    async listDeadLetters() {
      return [...rows.values()]
        .filter((row) => row.status === "dead-letter")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(cloneDelivery);
    },
    async replay(deliveryId) {
      const row = requireRow(rows, deliveryId);
      if (row.status !== "dead-letter") {
        throw new Error(`webhook delivery ${deliveryId} is not dead-lettered`);
      }
      const replay = {
        ...newDelivery({ subscriptionId: row.subscriptionId, event: row.event }, Date.now()),
      };
      rows.set(replay.id, replay);
      return cloneDelivery(replay);
    },
    async release(deliveryId) {
      const row = requireRow(rows, deliveryId);
      row.leaseExpiresAt = null;
    },
  };
}

function requireRow(rows: Map<string, WebhookDelivery>, deliveryId: string): WebhookDelivery {
  const row = rows.get(deliveryId);
  if (!row) throw new Error(`unknown webhook delivery ${deliveryId}`);
  return row;
}

/** Row shape returned by the SQLite statements below. */
type StoredRow = Record<string, unknown>;

function asString(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new Error(`webhook delivery column ${column} is not a string`);
}

function asNumber(value: unknown, column: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`webhook delivery column ${column} is not a number`);
}

function asNullableNumber(value: unknown, column: string): number | null {
  if (value === null) return null;
  return asNumber(value, column);
}

function asNullableString(value: unknown, column: string): string | null {
  if (value === null) return null;
  return asString(value, column);
}

function asStatus(value: unknown): WebhookDeliveryStatus {
  if (value === "pending" || value === "delivered" || value === "dead-letter") return value;
  throw new Error("webhook delivery column status is not a known status");
}

function decodeEvent(eventId: string, json: unknown): TollwayEvent {
  if (typeof json !== "string") {
    throw new Error("webhook delivery column event_json is not a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("webhook delivery event_json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("webhook delivery event_json is not an object");
  }
  const event = parsed as Record<string, unknown>;
  if (event.id !== eventId) {
    throw new Error("webhook delivery event id does not match the row");
  }
  if (!isWebhookEvent(event.type)) {
    throw new Error("webhook delivery event type is not a documented event");
  }
  if (typeof event.at !== "string") {
    throw new Error("webhook delivery event at is not a string");
  }
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
    throw new Error("webhook delivery event data is not an object");
  }
  return {
    id: eventId,
    type: event.type,
    at: event.at,
    data: event.data as Record<string, unknown>,
  };
}

function decodeRow(row: StoredRow): WebhookDelivery {
  const eventId = asString(row.event_id, "event_id");
  return {
    id: asString(row.id, "id"),
    eventId,
    subscriptionId: asString(row.subscription_id, "subscription_id"),
    event: decodeEvent(eventId, row.event_json),
    status: asStatus(row.status),
    attempts: asNumber(row.attempts, "attempts"),
    nextAttemptAt: asNumber(row.next_attempt_at, "next_attempt_at"),
    leaseExpiresAt: asNullableNumber(row.lease_expires_at, "lease_expires_at"),
    lastError: asNullableString(row.last_error, "last_error"),
    createdAt: asNumber(row.created_at, "created_at"),
  };
}

export type SqliteWebhookOutboxOptions = {
  /** Database file path, or `:memory:`. */
  filename: string;
};

export type SqliteWebhookOutbox = WebhookOutbox & {
  /** Closes the underlying database. */
  close(): void;
};

/**
 * SQLite-backed outbox using the built-in `node:sqlite` module, so it adds no
 * dependency. The claim is one `UPDATE ... RETURNING` inside `BEGIN
 * IMMEDIATE`, which is what makes two dispatchers safe against one file.
 *
 * `node:sqlite` is loaded inside this factory, not at module load, so an edge
 * runtime that never opens an outbox can still import the package.
 */
export function createSqliteWebhookOutbox(
  options: SqliteWebhookOutboxOptions,
): SqliteWebhookOutbox {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(options.filename);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due
      ON webhook_deliveries (status, next_attempt_at, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_dead_letter
      ON webhook_deliveries (status, created_at)
  `);

  const insert = db.prepare(`
    INSERT INTO webhook_deliveries (
      id, event_id, subscription_id, event_json, status, attempts,
      next_attempt_at, lease_expires_at, last_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const claimDue = db.prepare(`
    UPDATE webhook_deliveries
    SET lease_expires_at = ?
    WHERE id IN (
      SELECT id FROM webhook_deliveries
      WHERE status = 'pending'
        AND next_attempt_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY next_attempt_at, created_at
      LIMIT ?
    )
    RETURNING *
  `);
  const markDeliveredStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'delivered', lease_expires_at = NULL, last_error = NULL
    WHERE id = ?
  `);
  const markFailedStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET attempts = attempts + 1, next_attempt_at = ?, lease_expires_at = NULL, last_error = ?
    WHERE id = ?
  `);
  const deadLetterStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'dead-letter', lease_expires_at = NULL, last_error = ?
    WHERE id = ?
  `);
  const selectOne = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?");
  const selectDeadLetters = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE status = 'dead-letter'
    ORDER BY created_at
  `);
  const releaseLeaseStatement = db.prepare(
    "UPDATE webhook_deliveries SET lease_expires_at = NULL WHERE id = ?",
  );

  function row(deliveryId: string): WebhookDelivery {
    const found = selectOne.get(deliveryId);
    if (!found) throw new Error(`unknown webhook delivery ${deliveryId}`);
    return decodeRow(found);
  }

  function assertChanged(result: { changes: number | bigint }, deliveryId: string): void {
    if (result.changes === 0 || result.changes === 0n) {
      throw new Error(`unknown webhook delivery ${deliveryId}`);
    }
  }

  return {
    async enqueue(deliveries) {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const input of deliveries) {
          const delivery = newDelivery(input, now);
          insert.run(
            delivery.id,
            delivery.eventId,
            delivery.subscriptionId,
            JSON.stringify(delivery.event),
            delivery.status,
            delivery.attempts,
            delivery.nextAttemptAt,
            delivery.leaseExpiresAt,
            delivery.lastError,
            delivery.createdAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async claim(batch, leaseMs, now = Date.now()) {
      assertPositiveInteger(batch, "batch");
      assertPositiveInteger(leaseMs, "leaseMs");
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = claimDue.all(now + leaseMs, now, now, batch) as StoredRow[];
        db.exec("COMMIT");
        return rows.map(decodeRow);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async markDelivered(deliveryId) {
      assertChanged(markDeliveredStatement.run(deliveryId), deliveryId);
    },
    async markFailed(deliveryId, nextAttemptAt, error) {
      assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
      assertChanged(markFailedStatement.run(nextAttemptAt, error, deliveryId), deliveryId);
    },
    async deadLetter(deliveryId, error) {
      assertChanged(deadLetterStatement.run(error, deliveryId), deliveryId);
    },
    async listDeadLetters() {
      return (selectDeadLetters.all() as StoredRow[]).map(decodeRow);
    },
    async replay(deliveryId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const original = row(deliveryId);
        if (original.status !== "dead-letter") {
          throw new Error(`webhook delivery ${deliveryId} is not dead-lettered`);
        }
        const replay = newDelivery(
          { subscriptionId: original.subscriptionId, event: original.event },
          Date.now(),
        );
        insert.run(
          replay.id,
          replay.eventId,
          replay.subscriptionId,
          JSON.stringify(replay.event),
          replay.status,
          replay.attempts,
          replay.nextAttemptAt,
          replay.leaseExpiresAt,
          replay.lastError,
          replay.createdAt,
        );
        db.exec("COMMIT");
        return replay;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async release(deliveryId) {
      assertChanged(releaseLeaseStatement.run(deliveryId), deliveryId);
    },
    close() {
      db.close();
    },
  };
}
