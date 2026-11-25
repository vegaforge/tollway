import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TollwayEvent } from "./events.js";
import {
  createMemoryWebhookOutbox,
  createSqliteWebhookOutbox,
  type SqliteWebhookOutbox,
  type WebhookDelivery,
  type WebhookLease,
  type WebhookOutbox,
} from "./outbox.js";

const event: TollwayEvent = {
  id: "evt-1",
  type: "receipt.created",
  at: "2026-11-23T00:00:00.000Z",
  data: { receiptId: "r-1" },
};

type Backend = {
  name: string;
  create: () => { outbox: WebhookOutbox; cleanup: () => void };
};

function temporaryDatabase(): { filename: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "tollway-outbox-"));
  return {
    filename: join(directory, "outbox.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const backends: Backend[] = [
  {
    name: "memory",
    create: () => ({ outbox: createMemoryWebhookOutbox(), cleanup: () => {} }),
  },
  {
    name: "sqlite",
    create: () => {
      const database = temporaryDatabase();
      const outbox = createSqliteWebhookOutbox({ filename: database.filename });
      return {
        outbox,
        cleanup: () => {
          outbox.close();
          database.cleanup();
        },
      };
    },
  },
];

function leaseOf(delivery: WebhookDelivery | undefined): WebhookLease {
  if (!delivery?.leaseToken) throw new Error("expected a claimed row with a lease token");
  return { deliveryId: delivery.id, leaseToken: delivery.leaseToken };
}

describe.each(backends)("webhook outbox conformance: $name", (backend) => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  function setup(): WebhookOutbox {
    const created = backend.create();
    cleanup = created.cleanup;
    return created.outbox;
  }

  /** Enqueues one row and claims it, returning the claimed row. */
  async function claimOne(outbox: WebhookOutbox, leaseMs = 1_000): Promise<WebhookDelivery> {
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
    const [claimed] = await outbox.claim(10, leaseMs);
    if (!claimed) throw new Error("expected a row to claim");
    return claimed;
  }

  it("enqueues a pending row due now", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);

    expect(claimed.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed).toMatchObject({
      eventId: "evt-1",
      subscriptionId: "sub-1",
      event,
      status: "pending",
      attempts: 0,
      lastError: null,
      completedAt: null,
      replayedAs: null,
    });
  });

  it("claims at most the batch size and hands each row to one claimant", async () => {
    const outbox = setup();
    await outbox.enqueue([
      { subscriptionId: "sub-1", event },
      { subscriptionId: "sub-2", event },
      { subscriptionId: "sub-3", event },
    ]);

    const first = await outbox.claim(2, 1_000);
    const second = await outbox.claim(2, 1_000);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    const ids = [...first, ...second].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not hand out a leased row until the lease expires, then with a new token", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const leasedAt = Date.now();
    const [first] = await outbox.claim(10, 1_000, leasedAt);
    expect(first).toBeDefined();
    expect(await outbox.claim(10, 1_000, leasedAt + 999)).toHaveLength(0);
    const [second] = await outbox.claim(10, 1_000, leasedAt + 1_001);
    expect(second?.id).toBe(first?.id);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
  });

  it("releases a lease without counting an attempt", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox, 60_000);

    expect(await outbox.release(leaseOf(claimed))).toBe(true);

    const [again] = await outbox.claim(10, 1_000);
    expect(again?.id).toBe(claimed.id);
    expect(again?.attempts).toBe(0);
  });

  it("stops handing out a delivered row", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);

    expect(await outbox.markDelivered(leaseOf(claimed))).toBe(true);

    expect(await outbox.claim(10, 1_000, Date.now() + 10_000)).toHaveLength(0);
    expect(await outbox.listDeadLetters()).toHaveLength(0);
  });

  it("backs a failed row off until its next attempt", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);
    const dueAt = Date.now() + 5_000;

    expect(await outbox.markFailed(leaseOf(claimed), dueAt, "upstream 503")).toBe(true);

    expect(await outbox.claim(10, 1_000, dueAt - 1)).toHaveLength(0);
    const [retried] = await outbox.claim(10, 1_000, dueAt);
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe("upstream 503");
  });

  it("dead-letters a row, counting the final attempt, and lists it", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);

    expect(await outbox.deadLetter(leaseOf(claimed), "exhausted", { now: 1_234 })).toBe(true);

    expect(await outbox.claim(10, 1_000, Date.now() + 60_000)).toHaveLength(0);
    const dead = await outbox.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      id: claimed.id,
      status: "dead-letter",
      attempts: 1,
      lastError: "exhausted",
      subscriptionId: "sub-1",
      completedAt: 1_234,
      leaseToken: null,
    });
    expect(dead[0]?.event).toEqual(event);
  });

  it("dead-letters without counting an attempt when nothing was sent", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);

    await outbox.deadLetter(leaseOf(claimed), "subscription gone", { countAttempt: false });

    const [dead] = await outbox.listDeadLetters();
    expect(dead?.attempts).toBe(0);
  });

  it("replays a dead letter once, as a fresh pending delivery", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);
    await outbox.deadLetter(leaseOf(claimed), "exhausted");

    const replay = await outbox.replay(claimed.id);
    expect(replay.id).not.toBe(claimed.id);
    expect(replay).toMatchObject({
      eventId: "evt-1",
      subscriptionId: "sub-1",
      status: "pending",
      attempts: 0,
      lastError: null,
    });

    const [delivery] = await outbox.claim(10, 1_000);
    expect(delivery?.id).toBe(replay.id);
    const [original] = await outbox.listDeadLetters();
    expect(original?.replayedAs).toBe(replay.id);
  });

  it("refuses to replay the same dead letter twice", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);
    await outbox.deadLetter(leaseOf(claimed), "exhausted");
    const first = await outbox.replay(claimed.id);

    await expect(outbox.replay(claimed.id)).rejects.toThrow(`already replayed as ${first.id}`);
    // Only the first replay is pending.
    expect(await outbox.claim(10, 1_000)).toHaveLength(1);
  });

  it("refuses to replay a row that has not dead-lettered", async () => {
    const outbox = setup();
    const claimed = await claimOne(outbox);
    await expect(outbox.replay(claimed.id)).rejects.toThrow(/not dead-lettered/);
  });

  it("rejects unknown delivery ids instead of silently succeeding", async () => {
    const outbox = setup();
    const lease = { deliveryId: "missing", leaseToken: "token" };
    await expect(outbox.markDelivered(lease)).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.markFailed(lease, 0, "x")).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.deadLetter(lease, "x")).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.release(lease)).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.replay("missing")).rejects.toThrow(/unknown webhook delivery/);
  });

  it("rejects a claim batch or lease below one", async () => {
    const outbox = setup();
    await expect(outbox.claim(0, 1_000)).rejects.toBeInstanceOf(RangeError);
    await expect(outbox.claim(1, 0)).rejects.toBeInstanceOf(RangeError);
  });

  describe("a result written after the lease was lost", () => {
    // Dispatcher A claims a row, its lease expires, and B reclaims and
    // finishes it. A's late result must change nothing.
    async function reclaimed(outbox: WebhookOutbox): Promise<{
      stale: WebhookLease;
      current: WebhookLease;
    }> {
      await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
      const start = Date.now();
      const [first] = await outbox.claim(10, 50, start);
      const [second] = await outbox.claim(10, 50, start + 51);
      return { stale: leaseOf(first), current: leaseOf(second) };
    }

    it("cannot overwrite a delivery with a dead letter", async () => {
      const outbox = setup();
      const { stale, current } = await reclaimed(outbox);

      expect(await outbox.markDelivered(current)).toBe(true);
      expect(await outbox.deadLetter(stale, "late failure")).toBe(false);

      // The row stays delivered: nothing to replay, nothing to send again.
      expect(await outbox.listDeadLetters()).toHaveLength(0);
      expect(await outbox.claim(10, 1_000, Date.now() + 60_000)).toHaveLength(0);
    });

    it("cannot record a failure, a delivery or a release over the new holder", async () => {
      const outbox = setup();
      const { stale, current } = await reclaimed(outbox);

      expect(await outbox.markFailed(stale, 0, "late failure")).toBe(false);
      expect(await outbox.markDelivered(stale)).toBe(false);
      expect(await outbox.release(stale)).toBe(false);

      // The new holder still owns the row and records its own result.
      expect(await outbox.markFailed(current, 0, "its own failure")).toBe(true);
      const [retried] = await outbox.claim(10, 1_000, Date.now() + 60_000);
      expect(retried?.attempts).toBe(1);
      expect(retried?.lastError).toBe("its own failure");
    });

    it("cannot change a row after it dead-lettered", async () => {
      const outbox = setup();
      const { stale, current } = await reclaimed(outbox);

      expect(await outbox.deadLetter(current, "exhausted")).toBe(true);
      expect(await outbox.markDelivered(stale)).toBe(false);

      const [dead] = await outbox.listDeadLetters();
      expect(dead).toMatchObject({ status: "dead-letter", lastError: "exhausted", attempts: 1 });
    });
  });

  describe("retention", () => {
    it("purges delivered rows completed at or before the cutoff", async () => {
      const outbox = setup();
      await outbox.enqueue([
        { subscriptionId: "sub-1", event },
        { subscriptionId: "sub-2", event },
      ]);
      const [early, late] = await outbox.claim(10, 1_000);
      await outbox.markDelivered(leaseOf(early), 1_000);
      await outbox.markDelivered(leaseOf(late), 2_000);

      expect(await outbox.purgeDelivered(999)).toBe(0);
      expect(await outbox.purgeDelivered(1_000)).toBe(1);
      expect(await outbox.purgeDelivered(5_000)).toBe(1);
      expect(await outbox.purgeDelivered(5_000)).toBe(0);
    });

    it("never purges pending or dead-letter rows", async () => {
      const outbox = setup();
      await outbox.enqueue([
        { subscriptionId: "sub-1", event },
        { subscriptionId: "sub-2", event },
      ]);
      const [dead] = await outbox.claim(1, 1_000);
      await outbox.deadLetter(leaseOf(dead), "exhausted", { now: 1_000 });

      expect(await outbox.purgeDelivered(Date.now() + 60_000)).toBe(0);
      expect(await outbox.listDeadLetters()).toHaveLength(1);
      expect(await outbox.claim(10, 1_000)).toHaveLength(1);
    });

    it("reports a lost lease, not an unknown id, for a row purged after delivery", async () => {
      const outbox = setup();
      const claimed = await claimOne(outbox);
      await outbox.markDelivered(leaseOf(claimed), 1_000);

      expect(await outbox.markDelivered(leaseOf(claimed))).toBe(false);
    });
  });
});

describe("memory webhook outbox: growth", () => {
  it("drops delivered rows, so claims only scan live work", async () => {
    const outbox = createMemoryWebhookOutbox();
    await outbox.enqueue(Array.from({ length: 50 }, () => ({ subscriptionId: "sub-1", event })));
    const claimed = await outbox.claim(50, 1_000);
    for (const row of claimed) await outbox.markDelivered(leaseOf(row), 1_000);

    // Every delivered id is still known for late writes until it is purged.
    expect(await outbox.purgeDelivered(1_000)).toBe(50);
    expect(await outbox.claim(50, 1_000, Date.now() + 60_000)).toHaveLength(0);
  });
});

describe("sqlite webhook outbox: durability", () => {
  it("keeps pending rows across a reopen", async () => {
    const database = temporaryDatabase();
    const first: SqliteWebhookOutbox = createSqliteWebhookOutbox({ filename: database.filename });
    try {
      await first.enqueue([{ subscriptionId: "sub-1", event }]);
    } finally {
      first.close();
    }

    const second = createSqliteWebhookOutbox({ filename: database.filename });
    try {
      const [reopened] = await second.claim(10, 1_000);
      expect(reopened?.eventId).toBe("evt-1");
      expect(reopened?.subscriptionId).toBe("sub-1");
      expect(reopened?.event).toEqual(event);
    } finally {
      second.close();
      database.cleanup();
    }
  });

  it("keeps dead letters across a reopen", async () => {
    const database = temporaryDatabase();
    const first = createSqliteWebhookOutbox({ filename: database.filename });
    try {
      await first.enqueue([{ subscriptionId: "sub-1", event }]);
      const [claimed] = await first.claim(1, 1_000);
      await first.deadLetter(leaseOf(claimed), "exhausted");
    } finally {
      first.close();
    }

    const second = createSqliteWebhookOutbox({ filename: database.filename });
    try {
      const dead = await second.listDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.event).toEqual(event);
    } finally {
      second.close();
      database.cleanup();
    }
  });

  it("keeps a lease guard across connections: a stale write from one file handle changes nothing", async () => {
    const database = temporaryDatabase();
    const a = createSqliteWebhookOutbox({ filename: database.filename });
    const b = createSqliteWebhookOutbox({ filename: database.filename });
    try {
      await a.enqueue([{ subscriptionId: "sub-1", event }]);
      const start = Date.now();
      const [stale] = await a.claim(10, 50, start);
      const [current] = await b.claim(10, 50, start + 51);

      expect(await b.markDelivered(leaseOf(current))).toBe(true);
      expect(await a.deadLetter(leaseOf(stale), "late failure")).toBe(false);
      expect(await b.listDeadLetters()).toHaveLength(0);
    } finally {
      a.close();
      b.close();
      database.cleanup();
    }
  });
});

describe("sqlite webhook outbox: a lock held by another connection", () => {
  /**
   * Starts a worker thread that opens the same file and takes the write lock
   * with BEGIN IMMEDIATE. It holds the lock until `beginWrite()` is called,
   * then for `holdMs` more. A separate thread is needed because `node:sqlite`
   * is synchronous: a lock held on this thread could never be released while
   * this thread waits for it. Counting the hold from `beginWrite()` means the
   * lock is still held when the write starts, however slowly the worker's
   * message arrives.
   */
  async function holdWriteLock(
    filename: string,
    holdMs: number,
  ): Promise<{ worker: Worker; beginWrite: () => void }> {
    const signal = new SharedArrayBuffer(4);
    const worker = new Worker(new URL("./test-support/sqlite-lock-holder.mjs", import.meta.url), {
      workerData: { filename, holdMs, signal },
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message) => {
        if (message === "locked") resolve();
      });
      worker.once("error", reject);
    });
    const flag = new Int32Array(signal);
    return {
      worker,
      beginWrite: () => {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      },
    };
  }

  function exited(worker: Worker): Promise<number> {
    return new Promise((resolve) => worker.once("exit", resolve));
  }

  it("waits for the lock and writes once it is released", async () => {
    const database = temporaryDatabase();
    const outbox = createSqliteWebhookOutbox({
      filename: database.filename,
      busyTimeoutMs: 5_000,
    });
    try {
      const { worker, beginWrite } = await holdWriteLock(database.filename, 200);
      const done = exited(worker);

      const startedAt = Date.now();
      beginWrite();
      await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      expect(await outbox.claim(10, 1_000)).toHaveLength(1);
      expect(await done).toBe(0);
    } finally {
      outbox.close();
      database.cleanup();
    }
  });

  it("rejects with database is locked once the busy timeout passes", async () => {
    const database = temporaryDatabase();
    const outbox = createSqliteWebhookOutbox({ filename: database.filename, busyTimeoutMs: 50 });
    try {
      const { worker, beginWrite } = await holdWriteLock(database.filename, 1_000);
      const done = exited(worker);

      beginWrite();
      await expect(outbox.enqueue([{ subscriptionId: "sub-1", event }])).rejects.toThrow(
        /database is locked/,
      );
      await done;
    } finally {
      outbox.close();
      database.cleanup();
    }
  });

  it("rejects a negative busy timeout", () => {
    expect(() => createSqliteWebhookOutbox({ filename: ":memory:", busyTimeoutMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe("sqlite webhook outbox: unsupported Node", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the Node version it needs when node:sqlite is unavailable", () => {
    vi.spyOn(process, "getBuiltinModule").mockImplementation(() => {
      throw new Error("No such built-in module: node:sqlite");
    });
    expect(() => createSqliteWebhookOutbox({ filename: ":memory:" })).toThrow(
      /needs node:sqlite, available without a flag from Node 22\.13\.0/,
    );
  });
});
