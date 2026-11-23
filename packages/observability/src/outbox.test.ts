import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TollwayEvent } from "./events.js";
import {
  createMemoryWebhookOutbox,
  createSqliteWebhookOutbox,
  type SqliteWebhookOutbox,
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

  it("enqueues a pending row due now", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    expect(claimed?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed).toMatchObject({
      eventId: "evt-1",
      subscriptionId: "sub-1",
      event,
      status: "pending",
      attempts: 0,
      lastError: null,
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

  it("does not hand out a leased row until the lease expires", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const leasedAt = Date.now();
    expect(await outbox.claim(10, 1_000, leasedAt)).toHaveLength(1);
    expect(await outbox.claim(10, 1_000, leasedAt + 999)).toHaveLength(0);
    expect(await outbox.claim(10, 1_000, leasedAt + 1_001)).toHaveLength(1);
  });

  it("releases a lease without counting an attempt", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 60_000);
    expect(claimed).toBeDefined();
    await outbox.release(claimed?.id ?? "");

    const [again] = await outbox.claim(10, 1_000);
    expect(again?.id).toBe(claimed?.id);
    expect(again?.attempts).toBe(0);
  });

  it("stops handing out a delivered row", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    await outbox.markDelivered(claimed?.id ?? "");

    expect(await outbox.claim(10, 1_000, Date.now() + 10_000)).toHaveLength(0);
    expect(await outbox.listDeadLetters()).toHaveLength(0);
  });

  it("backs a failed row off until its next attempt", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    const dueAt = Date.now() + 5_000;
    await outbox.markFailed(claimed?.id ?? "", dueAt, "upstream 503");

    expect(await outbox.claim(10, 1_000, dueAt - 1)).toHaveLength(0);
    const [retried] = await outbox.claim(10, 1_000, dueAt);
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe("upstream 503");
  });

  it("keeps dead-lettered rows out of claims and lists them", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    await outbox.deadLetter(claimed?.id ?? "", "exhausted");

    expect(await outbox.claim(10, 1_000, Date.now() + 60_000)).toHaveLength(0);
    const dead = await outbox.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      id: claimed?.id,
      status: "dead-letter",
      lastError: "exhausted",
      subscriptionId: "sub-1",
    });
    expect(dead[0]?.event).toEqual(event);
  });

  it("replays a dead letter as a fresh pending delivery", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    await outbox.deadLetter(claimed?.id ?? "", "exhausted");

    const replay = await outbox.replay(claimed?.id ?? "");
    expect(replay.id).not.toBe(claimed?.id);
    expect(replay).toMatchObject({
      eventId: "evt-1",
      subscriptionId: "sub-1",
      status: "pending",
      attempts: 0,
      lastError: null,
    });

    const [delivery] = await outbox.claim(10, 1_000);
    expect(delivery?.id).toBe(replay.id);
    expect(await outbox.listDeadLetters()).toHaveLength(1);
  });

  it("refuses to replay a row that has not dead-lettered", async () => {
    const outbox = setup();
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);

    const [claimed] = await outbox.claim(10, 1_000);
    expect(claimed).toBeDefined();
    await expect(outbox.replay(claimed?.id ?? "")).rejects.toThrow(/not dead-lettered/);
  });

  it("rejects unknown delivery ids instead of silently succeeding", async () => {
    const outbox = setup();
    await expect(outbox.markDelivered("missing")).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.release("missing")).rejects.toThrow(/unknown webhook delivery/);
    await expect(outbox.replay("missing")).rejects.toThrow(/unknown webhook delivery/);
  });

  it("rejects a claim batch or lease below one", async () => {
    const outbox = setup();
    await expect(outbox.claim(0, 1_000)).rejects.toBeInstanceOf(RangeError);
    await expect(outbox.claim(1, 0)).rejects.toBeInstanceOf(RangeError);
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
      await first.deadLetter(claimed?.id ?? "", "exhausted");
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
});
