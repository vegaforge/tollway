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
  /**
   * Per-delivery id, new on every enqueue and replay, and the same across
   * every retry of this row. Receivers dedupe on the event id, not on this.
   */
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
  /**
   * Random token for the current claim, set by `claim` and cleared when the
   * lease ends. A result is recorded only by the holder of this token, so a
   * dispatcher whose lease expired cannot overwrite the result of the one
   * that reclaimed the row.
   */
  leaseToken: string | null;
  /** Last failure message. Never contains headers or the secret. */
  lastError: string | null;
  createdAt: number;
  /** Epoch milliseconds when the row was delivered or dead-lettered. */
  completedAt: number | null;
  /** For a replayed dead letter, the id of the delivery that replaced it. */
  replayedAs: string | null;
};

/** The claim a dispatcher holds on one row: what every result write names. */
export type WebhookLease = {
  deliveryId: string;
  leaseToken: string;
};

/** What `emit` hands the outbox: the delivery row is built by the store. */
export type NewWebhookDelivery = {
  subscriptionId: string;
  event: TollwayEvent;
};

/**
 * Persistence boundary for webhook deliveries. Every method may reject; the
 * dispatcher treats a rejected claim as a failed pass and retries next tick.
 *
 * Result writes (`markDelivered`, `markFailed`, `deadLetter`, `release`) name
 * the lease they were claimed with. They resolve `true` when they applied and
 * `false` when the caller no longer holds the lease: it expired and another
 * dispatcher reclaimed the row, or the row is no longer pending. They reject
 * for an id the store has never seen.
 */
export interface WebhookOutbox {
  /** Writes one pending row per delivery, due immediately. */
  enqueue(deliveries: readonly NewWebhookDelivery[]): Promise<void>;
  /**
   * Atomically takes up to `batch` due, unleased rows and leases them for
   * `leaseMs`, each with a fresh `leaseToken`. Two concurrent claimants never
   * receive the same row. `now` defaults to `Date.now()`.
   */
  claim(batch: number, leaseMs: number, now?: number): Promise<WebhookDelivery[]>;
  /** Marks the row delivered. `now` stamps `completedAt`. */
  markDelivered(lease: WebhookLease, now?: number): Promise<boolean>;
  /** Records a failed attempt and the next time the row is due. */
  markFailed(lease: WebhookLease, nextAttemptAt: number, error: string): Promise<boolean>;
  /**
   * Moves the row to dead letter. `countAttempt` (default `true`) counts the
   * attempt that just failed; pass `false` when nothing was sent, for example
   * because the subscription is gone.
   */
  deadLetter(
    lease: WebhookLease,
    error: string,
    options?: { countAttempt?: boolean; now?: number },
  ): Promise<boolean>;
  /** Dead-letter rows, oldest first, replayed ones included. */
  listDeadLetters(): Promise<WebhookDelivery[]>;
  /**
   * Re-enqueues a dead-letter row as a new pending delivery with attempts
   * reset and a fresh delivery id, and records the new id on the original as
   * `replayedAs`. Returns the new row. Throws when the id is unknown, the row
   * is not dead-lettered, or it was already replayed.
   */
  replay(deliveryId: string): Promise<WebhookDelivery>;
  /**
   * Drops a lease without counting an attempt, so another dispatcher can
   * claim the row immediately. Called when a dispatcher stops with work in
   * flight, after the request has been aborted.
   */
  release(lease: WebhookLease): Promise<boolean>;
  /**
   * Deletes delivered rows completed at or before `olderThan` (epoch
   * milliseconds) and returns how many were removed. Pending and dead-letter
   * rows are never purged.
   */
  purgeDelivered(olderThan: number): Promise<number>;
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
    leaseToken: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
    replayedAs: null,
  };
}

function cloneDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return { ...delivery, event: { ...delivery.event } };
}

/**
 * In-process outbox. Rows disappear with the process. A delivered row is
 * dropped at once, since nothing reads it again, so a long-running process
 * holds only pending and dead-letter rows.
 */
export function createMemoryWebhookOutbox(): WebhookOutbox {
  const rows = new Map<string, WebhookDelivery>();

  /**
   * The row, when `lease` still holds it. Throws for an id never seen, which
   * is a caller bug, and returns undefined for a lease that was lost.
   */
  function held(lease: WebhookLease): WebhookDelivery | undefined {
    const row = rows.get(lease.deliveryId);
    if (!row) {
      if (delivered.has(lease.deliveryId)) return undefined;
      throw new Error(`unknown webhook delivery ${lease.deliveryId}`);
    }
    if (row.status !== "pending" || row.leaseToken !== lease.leaseToken) return undefined;
    return row;
  }

  // Rows dropped after delivery, by id, with the time they completed, so a
  // late result write for one of them reports a lost lease instead of an
  // unknown id. Only the id and the time are kept, and purgeDelivered drops
  // them under the same retention as the SQLite store.
  const delivered = new Map<string, number>();

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
        row.leaseToken = randomUUID();
      }
      return due.map(cloneDelivery);
    },
    async markDelivered(lease, now = Date.now()) {
      const row = held(lease);
      if (!row) return false;
      rows.delete(row.id);
      delivered.set(row.id, now);
      return true;
    },
    async markFailed(lease, nextAttemptAt, error) {
      assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
      const row = held(lease);
      if (!row) return false;
      row.attempts += 1;
      row.nextAttemptAt = nextAttemptAt;
      row.leaseExpiresAt = null;
      row.leaseToken = null;
      row.lastError = error;
      return true;
    },
    async deadLetter(lease, error, options = {}) {
      const row = held(lease);
      if (!row) return false;
      if (options.countAttempt ?? true) row.attempts += 1;
      row.status = "dead-letter";
      row.leaseExpiresAt = null;
      row.leaseToken = null;
      row.lastError = error;
      row.completedAt = options.now ?? Date.now();
      return true;
    },
    async listDeadLetters() {
      return [...rows.values()]
        .filter((row) => row.status === "dead-letter")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(cloneDelivery);
    },
    async replay(deliveryId) {
      const row = rows.get(deliveryId);
      if (!row) throw new Error(`unknown webhook delivery ${deliveryId}`);
      assertReplayable(row);
      const replay = newDelivery(
        { subscriptionId: row.subscriptionId, event: row.event },
        Date.now(),
      );
      rows.set(replay.id, replay);
      row.replayedAs = replay.id;
      return cloneDelivery(replay);
    },
    async release(lease) {
      const row = held(lease);
      if (!row) return false;
      row.leaseExpiresAt = null;
      row.leaseToken = null;
      return true;
    },
    async purgeDelivered(olderThan) {
      assertNonNegativeInteger(olderThan, "olderThan");
      let removed = 0;
      for (const [id, completedAt] of delivered) {
        if (completedAt <= olderThan) {
          delivered.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

function assertReplayable(row: WebhookDelivery): void {
  if (row.status !== "dead-letter") {
    throw new Error(`webhook delivery ${row.id} is not dead-lettered`);
  }
  if (row.replayedAs !== null) {
    throw new Error(`webhook delivery ${row.id} was already replayed as ${row.replayedAs}`);
  }
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
    leaseToken: asNullableString(row.lease_token, "lease_token"),
    lastError: asNullableString(row.last_error, "last_error"),
    createdAt: asNumber(row.created_at, "created_at"),
    completedAt: asNullableNumber(row.completed_at, "completed_at"),
    replayedAs: asNullableString(row.replayed_as, "replayed_as"),
  };
}

export type SqliteWebhookOutboxOptions = {
  /** Database file path, or `:memory:`. */
  filename: string;
  /**
   * How long a write waits for another connection's lock before it fails
   * with `database is locked`. Defaults to 500ms. `node:sqlite` is
   * synchronous, so the wait blocks the event loop: keep it short. A write
   * that still fails is reported, never lost silently: `emit` lists it as a
   * delivery failure.
   */
  busyTimeoutMs?: number;
};

export type SqliteWebhookOutbox = WebhookOutbox & {
  /** Closes the underlying database. */
  close(): void;
};

/** The first Node release where `node:sqlite` works without a flag. */
const SQLITE_MINIMUM_NODE = "22.13.0";

const DEFAULT_BUSY_TIMEOUT_MS = 500;

/**
 * Loads `node:sqlite`, or throws an error that names the Node version it
 * needs. Older releases either lack `process.getBuiltinModule` or keep the
 * module behind `--experimental-sqlite`.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const unavailable = () =>
    new Error(
      `createSqliteWebhookOutbox needs node:sqlite, available without a flag from Node ${SQLITE_MINIMUM_NODE}; this is Node ${process.versions.node}`,
    );
  if (typeof process.getBuiltinModule !== "function") throw unavailable();
  let sqlite: typeof import("node:sqlite") | undefined;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } catch (cause) {
    throw Object.assign(unavailable(), { cause });
  }
  if (!sqlite) throw unavailable();
  return sqlite;
}

/**
 * SQLite-backed outbox using the built-in `node:sqlite` module, so it adds no
 * dependency. The claim is one `UPDATE ... RETURNING` inside `BEGIN
 * IMMEDIATE`, which is what makes two dispatchers safe against one file, and
 * every result write is conditional on the claim's `lease_token`.
 *
 * `node:sqlite` is loaded inside this factory, not at module load, so an edge
 * runtime that never opens an outbox can still import the package.
 */
export function createSqliteWebhookOutbox(
  options: SqliteWebhookOutboxOptions,
): SqliteWebhookOutbox {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  assertNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(options.filename);
  // Set first, so even the schema statements below wait for a lock held by
  // another process instead of failing at once.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
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
      lease_token TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      replayed_as TEXT
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_completed
      ON webhook_deliveries (status, completed_at)
  `);

  const insert = db.prepare(`
    INSERT INTO webhook_deliveries (
      id, event_id, subscription_id, event_json, status, attempts,
      next_attempt_at, lease_expires_at, lease_token, last_error, created_at,
      completed_at, replayed_as
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectDue = db.prepare(`
    SELECT id FROM webhook_deliveries
    WHERE status = 'pending'
      AND next_attempt_at <= ?
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    ORDER BY next_attempt_at, created_at
    LIMIT ?
  `);
  const leaseOne = db.prepare(`
    UPDATE webhook_deliveries
    SET lease_expires_at = ?, lease_token = ?
    WHERE id = ?
    RETURNING *
  `);
  // Every result write below matches on the lease token and on 'pending', so
  // a dispatcher whose lease expired changes nothing.
  const markDeliveredStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'delivered', lease_expires_at = NULL, lease_token = NULL,
        last_error = NULL, completed_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'pending'
  `);
  const markFailedStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET attempts = attempts + 1, next_attempt_at = ?, lease_expires_at = NULL,
        lease_token = NULL, last_error = ?
    WHERE id = ? AND lease_token = ? AND status = 'pending'
  `);
  const deadLetterStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'dead-letter', attempts = attempts + ?, lease_expires_at = NULL,
        lease_token = NULL, last_error = ?, completed_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'pending'
  `);
  const releaseLeaseStatement = db.prepare(`
    UPDATE webhook_deliveries
    SET lease_expires_at = NULL, lease_token = NULL
    WHERE id = ? AND lease_token = ? AND status = 'pending'
  `);
  const markReplayed = db.prepare(
    "UPDATE webhook_deliveries SET replayed_as = ? WHERE id = ? AND replayed_as IS NULL",
  );
  const purgeStatement = db.prepare(`
    DELETE FROM webhook_deliveries
    WHERE status = 'delivered' AND completed_at <= ?
  `);
  const selectOne = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?");
  const exists = db.prepare("SELECT 1 FROM webhook_deliveries WHERE id = ?");
  const selectDeadLetters = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE status = 'dead-letter'
    ORDER BY created_at
  `);

  function row(deliveryId: string): WebhookDelivery {
    const found = selectOne.get(deliveryId);
    if (!found) throw new Error(`unknown webhook delivery ${deliveryId}`);
    return decodeRow(found);
  }

  /**
   * True when a lease-guarded write changed its row. When it changed
   * nothing, tells a lost lease (false) from an id the store has never seen
   * (an error).
   */
  function applied(result: { changes: number | bigint }, deliveryId: string): boolean {
    if (Number(result.changes) > 0) return true;
    if (!exists.get(deliveryId)) throw new Error(`unknown webhook delivery ${deliveryId}`);
    return false;
  }

  function insertDelivery(delivery: WebhookDelivery): void {
    insert.run(
      delivery.id,
      delivery.eventId,
      delivery.subscriptionId,
      JSON.stringify(delivery.event),
      delivery.status,
      delivery.attempts,
      delivery.nextAttemptAt,
      delivery.leaseExpiresAt,
      delivery.leaseToken,
      delivery.lastError,
      delivery.createdAt,
      delivery.completedAt,
      delivery.replayedAs,
    );
  }

  /** Runs `work` inside `BEGIN IMMEDIATE`, rolling back when it throws. */
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async enqueue(deliveries) {
      const now = Date.now();
      transaction(() => {
        for (const input of deliveries) insertDelivery(newDelivery(input, now));
      });
    },
    async claim(batch, leaseMs, now = Date.now()) {
      assertPositiveInteger(batch, "batch");
      assertPositiveInteger(leaseMs, "leaseMs");
      return transaction(() => {
        const due = selectDue.all(now, now, batch) as StoredRow[];
        // One token per row, so each claim can be told apart from the next.
        return due.map((candidate) =>
          decodeRow(
            leaseOne.get(now + leaseMs, randomUUID(), asString(candidate.id, "id")) as StoredRow,
          ),
        );
      });
    },
    async markDelivered(lease, now = Date.now()) {
      return applied(
        markDeliveredStatement.run(now, lease.deliveryId, lease.leaseToken),
        lease.deliveryId,
      );
    },
    async markFailed(lease, nextAttemptAt, error) {
      assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
      return applied(
        markFailedStatement.run(nextAttemptAt, error, lease.deliveryId, lease.leaseToken),
        lease.deliveryId,
      );
    },
    async deadLetter(lease, error, options = {}) {
      const counted = (options.countAttempt ?? true) ? 1 : 0;
      return applied(
        deadLetterStatement.run(
          counted,
          error,
          options.now ?? Date.now(),
          lease.deliveryId,
          lease.leaseToken,
        ),
        lease.deliveryId,
      );
    },
    async listDeadLetters() {
      return (selectDeadLetters.all() as StoredRow[]).map(decodeRow);
    },
    async replay(deliveryId) {
      return transaction(() => {
        const original = row(deliveryId);
        assertReplayable(original);
        const replay = newDelivery(
          { subscriptionId: original.subscriptionId, event: original.event },
          Date.now(),
        );
        insertDelivery(replay);
        markReplayed.run(replay.id, deliveryId);
        return replay;
      });
    },
    async release(lease) {
      return applied(
        releaseLeaseStatement.run(lease.deliveryId, lease.leaseToken),
        lease.deliveryId,
      );
    },
    async purgeDelivered(olderThan) {
      assertNonNegativeInteger(olderThan, "olderThan");
      return Number(purgeStatement.run(olderThan).changes);
    },
    close() {
      db.close();
    },
  };
}
