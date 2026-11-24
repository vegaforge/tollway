import { readFile } from "node:fs/promises";
import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { ChannelNotFoundError, CommitmentConflictError } from "../errors.js";
import { encodeChannelCursor } from "../store-query.js";
import {
  createPostgresCommitmentStore,
  type PostgresClient,
  type PostgresConnection,
  type PostgresQueryResult,
} from "./postgres.js";

type Row = Record<string, unknown>;
type Call = { text: string; values: readonly unknown[] | undefined };
type Responder = (text: string, values: readonly unknown[] | undefined) => PostgresQueryResult;

/**
 * A scripted stand-in for a pg Pool. Every query is recorded, and `respond`
 * decides the result. `released` records each release and whether it
 * destroyed the connection.
 */
function scriptedPool(respond: Responder): {
  pool: PostgresClient;
  calls: Call[];
  released: Array<boolean | undefined>;
} {
  const calls: Call[] = [];
  const released: Array<boolean | undefined> = [];
  const run = (text: string, values?: readonly unknown[]): PostgresQueryResult => {
    calls.push({ text, values });
    return respond(text, values);
  };
  const connection: PostgresConnection = {
    query: async (text, values) => run(text, values),
    release: (destroy) => {
      released.push(destroy);
    },
  };
  const pool: PostgresClient = {
    query: async (text, values) => run(text, values),
    connect: async () => connection,
  };
  return { pool, calls, released };
}

function rows(...list: Row[]): PostgresQueryResult {
  return { rows: list, rowCount: list.length };
}

const EMPTY: PostgresQueryResult = { rows: [], rowCount: 0 };

function channelRow(overrides: Row = {}): Row {
  return {
    id: "CPG",
    counterparty: "GRECIPIENT",
    asset: "USDC",
    deposit: "1000",
    committed: "0",
    sequence: -1,
    status: "open",
    network: "testnet",
    open_tx_hash: "tx-open",
    opened_at: "2026-11-24T00:00:00.000Z",
    last_commit_at: null,
    settlement_tx_hash: null,
    returned_remainder: null,
    close_attempt_id: null,
    close_attempt_ledger: null,
    close_attempt_started_at: null,
    settlement_expected_amount: null,
    settlement_observed_amount: null,
    ...overrides,
  };
}

const commitment = (sequence: number, cumulativeAmount: string) => ({
  channelId: "CPG",
  sequence,
  cumulativeAmount,
  commitment: `sig-${sequence}`,
});

const expectation = (expectedSequence: number) => ({
  expectedSequence,
  expectedStatus: "open" as const,
  lastCommitAt: "2026-11-24T01:00:00.000Z",
});

function texts(calls: readonly Call[]): string[] {
  return calls.map((call) => call.text.split(" ").slice(0, 2).join(" "));
}

describe("createPostgresCommitmentStore: appendCommitment", () => {
  it("runs the compare-and-set and the commitment insert in one transaction", async () => {
    const { pool, calls, released } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) {
        return rows(channelRow({ committed: "40", sequence: 0, last_commit_at: "t1" }));
      }
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    const advanced = await store.appendCommitment(commitment(0, "40"), expectation(-1));

    expect(advanced).toMatchObject({ committed: "40", sequence: 0, lastCommitAt: "t1" });
    expect(texts(calls)).toEqual(["BEGIN ISOLATION", "UPDATE channels", "INSERT INTO", "COMMIT"]);
    expect(released).toEqual([false]);
  });

  it("names a stale sequence, rolls back, and inserts nothing", async () => {
    const { pool, calls, released } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return EMPTY;
      if (text.startsWith("SELECT status")) return rows({ status: "open", sequence: 3 });
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    const attempt = store.appendCommitment(commitment(0, "40"), expectation(-1));

    await expect(attempt).rejects.toMatchObject({ field: "sequence", expected: "-1", actual: "3" });
    expect(texts(calls)).toContain("ROLLBACK");
    expect(texts(calls)).not.toContain("INSERT INTO");
    expect(texts(calls)).not.toContain("COMMIT");
    expect(released).toEqual([false]);
  });

  it("names a stale status before a stale sequence", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return EMPTY;
      if (text.startsWith("SELECT status")) return rows({ status: "closing", sequence: 9 });
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.appendCommitment(commitment(0, "40"), expectation(-1)),
    ).rejects.toMatchObject({ field: "status", actual: "closing" });
  });

  it("reports an unknown channel as not found", async () => {
    const { pool } = scriptedPool(() => EMPTY);
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.appendCommitment(commitment(0, "40"), expectation(-1)),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("turns a unique-key violation on the commitment row into a conflict", async () => {
    const { pool, calls } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return rows(channelRow({ sequence: 0 }));
      if (text.startsWith("INSERT INTO"))
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.appendCommitment(commitment(0, "40"), expectation(-1)),
    ).rejects.toBeInstanceOf(CommitmentConflictError);
    expect(texts(calls)).toContain("ROLLBACK");
    expect(texts(calls)).not.toContain("COMMIT");
  });

  it("rolls back a commitment that does not follow the expected sequence", async () => {
    const { pool, calls } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return rows(channelRow({ sequence: 5 }));
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.appendCommitment(commitment(5, "40"), expectation(-1)),
    ).rejects.toMatchObject({ field: "sequence", expected: "0", actual: "5" });
    expect(texts(calls)).toContain("ROLLBACK");
    expect(texts(calls)).not.toContain("INSERT INTO");
  });

  it("destroys the connection when the rollback itself fails, and throws the original error", async () => {
    const { pool, released } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return rows(channelRow({ sequence: 0 }));
      if (text.startsWith("INSERT INTO")) throw new Error("boom");
      if (text === "ROLLBACK") throw new Error("connection lost");
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(store.appendCommitment(commitment(0, "40"), expectation(-1))).rejects.toThrow(
      "boom",
    );
    expect(released).toEqual([true]);
  });

  it("runs on a single connection that has no connect, without releasing it", async () => {
    const calls: string[] = [];
    const connection: PostgresClient = {
      query: async (text: string) => {
        calls.push(text);
        if (text.startsWith("UPDATE")) return rows(channelRow({ sequence: 0 }));
        return EMPTY;
      },
    };
    const store = createPostgresCommitmentStore({ client: connection });

    await store.appendCommitment(commitment(0, "40"), expectation(-1));

    expect(calls[0]).toMatch(/^BEGIN/);
    expect(calls.at(-1)).toBe("COMMIT");
  });
});

describe("createPostgresCommitmentStore: other writes", () => {
  it("transitions a channel only from the expected status", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return rows(channelRow({ status: "closing" }));
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.transitionChannel("CPG", "open", { status: "closing" }),
    ).resolves.toMatchObject({ status: "closing" });
  });

  it("names the stale status on a failed transition", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("UPDATE")) return EMPTY;
      if (text.startsWith("SELECT status")) return rows({ status: "closed" });
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(
      store.transitionChannel("CPG", "open", { status: "closing" }),
    ).rejects.toMatchObject({ field: "status", expected: "open", actual: "closed" });
  });

  it("writes NULL for every optional column that putChannel does not set", async () => {
    const { pool, calls } = scriptedPool(() => EMPTY);
    const store = createPostgresCommitmentStore({ client: pool });

    await store.putChannel({
      id: "CPG",
      counterparty: "GR",
      asset: "USDC",
      deposit: "10",
      committed: "0",
      sequence: -1,
      status: "open",
      network: "testnet",
      openTxHash: "tx",
      openedAt: "2026-11-24T00:00:00.000Z",
    });

    const insert = calls.find((call) => call.text.startsWith("INSERT INTO channels"));
    expect(insert?.values).toContain(null);
    expect(insert?.text).toContain("ON CONFLICT (id) DO UPDATE SET");
  });

  it("returns only the optional fields the row sets", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("SELECT")) {
        return rows(
          channelRow({
            close_attempt_id: "att-1",
            close_attempt_ledger: 42,
            close_attempt_started_at: "t-close",
          }),
        );
      }
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    const channel = await store.getChannel("CPG");

    expect(channel?.closeAttempt).toEqual({
      attemptId: "att-1",
      startedAtLedger: 42,
      startedAt: "t-close",
    });
    expect(channel).not.toHaveProperty("lastCommitAt");
    expect(channel).not.toHaveProperty("settlementMismatch");
  });

  it("rejects a row whose status is not a channel status", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("SELECT")) return rows(channelRow({ status: "bogus" }));
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(store.getChannel("CPG")).rejects.toMatchObject({
      code: "corrupt-channel-record",
    });
  });

  it("rejects a row whose amount is not an integer string", async () => {
    const { pool } = scriptedPool((text) => {
      if (text.startsWith("SELECT")) return rows(channelRow({ committed: "1.5" }));
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(store.getChannel("CPG")).rejects.toBeInstanceOf(TollwayError);
  });

  it("builds the listing query from the set filters and reports a next cursor", async () => {
    const { pool, calls } = scriptedPool((text) => {
      if (text.startsWith("SELECT")) {
        return rows(channelRow({ id: "CC" }), channelRow({ id: "CB" }), channelRow({ id: "CA" }));
      }
      return EMPTY;
    });
    const store = createPostgresCommitmentStore({ client: pool });
    const cursor = encodeChannelCursor({ openedAt: "2026-11-24T00:00:00.000Z", id: "CD" });

    const page = await store.listChannels({ status: "open", network: "testnet", limit: 2, cursor });

    const select = calls.at(-1);
    expect(select?.text).toContain(
      "WHERE status = $1 AND network = $2 AND (opened_at, id) < ($3, $4)",
    );
    expect(select?.text).toContain("ORDER BY opened_at DESC, id DESC LIMIT $5");
    expect(select?.values).toEqual(["open", "testnet", "2026-11-24T00:00:00.000Z", "CD", 3]);
    expect(page.channels.map((c) => c.id)).toEqual(["CC", "CB"]);
    expect(page.nextCursor).toBe(
      encodeChannelCursor({ openedAt: "2026-11-24T00:00:00.000Z", id: "CB" }),
    );
  });

  it("rejects a page size outside 1 to 200, or a foreign cursor, before querying", async () => {
    const { pool, calls } = scriptedPool(() => EMPTY);
    const store = createPostgresCommitmentStore({ client: pool });

    await expect(store.listChannels({ limit: 201 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.listChannels({ cursor: "CA" })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("qualifies every table name with the schema when one is given", async () => {
    const { pool, calls } = scriptedPool(() => EMPTY);
    const store = createPostgresCommitmentStore({ client: pool, schema: "tollway" });

    await store.listCommitments("CPG");

    expect(calls[0]?.text).toContain('"tollway".commitments');
  });

  it("refuses a schema name that is not a plain identifier", () => {
    const { pool } = scriptedPool(() => EMPTY);

    expect(() =>
      createPostgresCommitmentStore({ client: pool, schema: "x; DROP TABLE y" }),
    ).toThrow(TollwayError);
  });
});

describe("migration 0001_commitment_store.sql", () => {
  it("creates the tables with exact amounts, the sequence backstop and the id collation", async () => {
    const sql = await readFile(
      new URL("../../migrations/0001_commitment_store.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("CREATE TABLE channels");
    expect(sql).toContain("CREATE TABLE commitments");
    expect(sql).toContain("NUMERIC(39, 0)");
    expect(sql).toContain("PRIMARY KEY (channel_id, sequence)");
    expect(sql).toContain('COLLATE "C"');
    expect(sql).toContain("CREATE INDEX channels_status_idx");
  });
});
