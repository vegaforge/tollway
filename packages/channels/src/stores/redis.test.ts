import { createHash } from "node:crypto";
import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { ChannelNotFoundError, CommitmentConflictError } from "../errors.js";
import { encodeChannelCursor } from "../store-query.js";
import { createRedisCommitmentStore, type RedisLikeClient } from "./redis.js";

type Log = { op: string; keys: string[]; args: string[] };

/**
 * A scripted stand-in for an ioredis client. Like Redis, EVALSHA fails with
 * NOSCRIPT until EVAL has loaded the script. `replies` decides what a script
 * returns, from the script text's first line.
 */
function fakeRedis(replies: (script: string) => unknown = () => ["ok"]): {
  client: RedisLikeClient;
  log: Log[];
  hashes: Map<string, Record<string, string>>;
  members: Map<string, string[]>;
  sets: Map<string, string[]>;
} {
  const log: Log[] = [];
  const loaded = new Set<string>();
  const hashes = new Map<string, Record<string, string>>();
  const members = new Map<string, string[]>();
  const sets = new Map<string, string[]>();

  const client: RedisLikeClient = {
    async eval(script, numKeys, ...rest) {
      log.push({ op: "eval", keys: rest.slice(0, numKeys), args: rest.slice(numKeys) });
      loaded.add(script);
      return replies(script);
    },
    async evalsha(sha, numKeys, ...rest) {
      log.push({ op: "evalsha", keys: rest.slice(0, numKeys), args: rest.slice(numKeys) });
      const script = [...loaded].find((s) => shaOf(s) === sha);
      if (script === undefined) {
        throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      }
      return replies(script);
    },
    async hgetall(key) {
      log.push({ op: "hgetall", keys: [key], args: [] });
      return hashes.get(key) ?? {};
    },
    async zrange(key) {
      log.push({ op: "zrange", keys: [key], args: [] });
      return members.get(key) ?? [];
    },
    async sadd(key, ...values) {
      log.push({ op: "sadd", keys: [key], args: values });
      sets.set(key, [...(sets.get(key) ?? []), ...values]);
      return values.length;
    },
    async smembers(key) {
      log.push({ op: "smembers", keys: [key], args: [] });
      return sets.get(key) ?? [];
    },
  };
  return { client, log, hashes, members, sets };
}

function shaOf(script: string): string {
  return createHash("sha1").update(script).digest("hex");
}

/** The record the append script returns after a write, as field and value pairs. */
const OK_CHANNEL_FIELDS: Record<string, string> = {
  id: "CR",
  counterparty: "GR",
  asset: "USDC",
  deposit: "1000",
  committed: "40",
  sequence: "0",
  status: "open",
  network: "testnet",
  openTxHash: "tx-open",
  openedAt: "2026-11-24T00:00:00.000Z",
  lastCommitAt: "2026-11-24T01:00:00.000Z",
};
const OK_CHANNEL_REPLY = ["ok", ...Object.entries(OK_CHANNEL_FIELDS).flat()];

function appendArgs(expectedSequence: number) {
  return {
    commitment: {
      channelId: "CR",
      sequence: expectedSequence + 1,
      cumulativeAmount: "40",
      commitment: "sig",
    },
    expectation: {
      expectedSequence,
      expectedStatus: "open" as const,
      lastCommitAt: "2026-11-24T01:00:00.000Z",
    },
  };
}

describe("createRedisCommitmentStore: script calls", () => {
  it("runs the append by SHA, falling back to EVAL once when Redis has not loaded it", async () => {
    const { client, log } = fakeRedis((script) =>
      script.includes("ZADD") ? OK_CHANNEL_REPLY : ["ok"],
    );
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await store.appendCommitment(commitment, expectation);
    await store.appendCommitment(commitment, expectation);

    expect(log.map((entry) => entry.op)).toEqual(["evalsha", "eval", "evalsha"]);
    const [first, second] = [log[0], log[2]];
    expect(first?.keys).toEqual(second?.keys);
  });

  it("keeps the record and the commitment stream in one hash tag", async () => {
    const { client, log } = fakeRedis(() => OK_CHANNEL_REPLY);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await store.appendCommitment(commitment, expectation);

    const append = log.find((entry) => entry.keys.length === 2);
    expect(append?.keys).toEqual(["tollway:ch:{CR}:record", "tollway:ch:{CR}:commitments"]);
  });

  it("lets a failure other than NOSCRIPT through without retrying with EVAL", async () => {
    const { client, log } = fakeRedis();
    client.evalsha = async () => {
      throw new Error("READONLY You can't write against a read only replica.");
    };
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await expect(store.appendCommitment(commitment, expectation)).rejects.toThrow("READONLY");
    expect(log.filter((entry) => entry.op === "eval")).toHaveLength(0);
  });

  it("indexes the channel id before it writes the record", async () => {
    const { client, log } = fakeRedis();
    const store = createRedisCommitmentStore({ client });

    await store.putChannel({
      id: "CIDX",
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

    expect(log[0]).toMatchObject({ op: "sadd", args: ["CIDX"] });
    const firstScript = log.findIndex((entry) => entry.op === "evalsha" || entry.op === "eval");
    expect(firstScript).toBeGreaterThan(0);
  });

  it("refuses a channel id that would break its hash tag", async () => {
    const { client } = fakeRedis();
    const store = createRedisCommitmentStore({ client });

    await expect(store.getChannel("A{B")).rejects.toMatchObject({ code: "invalid-store-config" });
    await expect(store.getChannel("")).rejects.toBeInstanceOf(TollwayError);
  });
});

describe("createRedisCommitmentStore: reply handling", () => {
  it("reports a stale sequence with the sequence the record holds", async () => {
    const { client } = fakeRedis(() => ["sequence", "3"]);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await expect(store.appendCommitment(commitment, expectation)).rejects.toMatchObject({
      name: "CommitmentConflictError",
      field: "sequence",
      expected: "-1",
      actual: "3",
    });
  });

  it("reports a stale status, and the status the record holds", async () => {
    const { client } = fakeRedis(() => ["status", "closing"]);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await expect(store.appendCommitment(commitment, expectation)).rejects.toMatchObject({
      field: "status",
      expected: "open",
      actual: "closing",
    });
  });

  it("reports a commitment that does not follow the expected sequence", async () => {
    const { client } = fakeRedis(() => ["next"]);
    const store = createRedisCommitmentStore({ client });
    const { expectation } = appendArgs(-1);
    const commitment = { channelId: "CR", sequence: 5, cumulativeAmount: "40", commitment: "s" };

    await expect(store.appendCommitment(commitment, expectation)).rejects.toMatchObject({
      field: "sequence",
      expected: "0",
      actual: "5",
    });
  });

  it("reports an append to an unknown channel as not found", async () => {
    const { client } = fakeRedis(() => ["missing"]);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await expect(store.appendCommitment(commitment, expectation)).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  it("returns the record the script wrote", async () => {
    const { client } = fakeRedis(() => OK_CHANNEL_REPLY);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    const channel = await store.appendCommitment(commitment, expectation);

    expect(channel).toMatchObject({
      id: "CR",
      committed: "40",
      sequence: 0,
      lastCommitAt: "2026-11-24T01:00:00.000Z",
    });
  });

  it("sends the expected status first when it transitions a channel", async () => {
    const { client, log } = fakeRedis(() => ["status", "closed"]);
    const store = createRedisCommitmentStore({ client });

    await expect(
      store.transitionChannel("CR", "open", { status: "closing" }),
    ).rejects.toBeInstanceOf(CommitmentConflictError);
    expect(log.at(-1)?.args[0]).toBe("open");
  });

  it("resolves undefined when an update finds no record", async () => {
    const { client } = fakeRedis(() => ["missing"]);
    const store = createRedisCommitmentStore({ client });

    await expect(store.updateChannel("CNONE", { status: "closed" })).resolves.toBeUndefined();
  });

  it("rejects a reply that is not a list of strings", async () => {
    const { client } = fakeRedis(() => 42);
    const store = createRedisCommitmentStore({ client });
    const { commitment, expectation } = appendArgs(-1);

    await expect(store.appendCommitment(commitment, expectation)).rejects.toMatchObject({
      code: "corrupt-channel-record",
    });
  });

  it("rejects a commitment in the stream whose amount is not an integer", async () => {
    const { client, members } = fakeRedis();
    const bad = { channelId: "CR", sequence: 0, cumulativeAmount: "1.5", commitment: "s" };
    members.set("tollway:ch:{CR}:commitments", [JSON.stringify(bad)]);
    const store = createRedisCommitmentStore({ client });

    await expect(store.listCommitments("CR")).rejects.toMatchObject({
      code: "corrupt-channel-record",
    });
  });
});

describe("createRedisCommitmentStore: listings", () => {
  it("skips an indexed id whose record is gone, and pages the rest", async () => {
    const { client, hashes, sets } = fakeRedis();
    const record = (id: string) => ({
      id,
      counterparty: "GR",
      asset: "USDC",
      deposit: "10",
      committed: "0",
      sequence: "-1",
      status: "open",
      network: "testnet",
      openTxHash: "tx",
      openedAt: "2026-11-24T00:00:00.000Z",
    });
    sets.set("tollway:ch:index", ["CB", "CA", "CGONE"]);
    hashes.set("tollway:ch:{CA}:record", record("CA"));
    hashes.set("tollway:ch:{CB}:record", record("CB"));
    const store = createRedisCommitmentStore({ client });

    const page = await store.listChannels({ limit: 1 });

    expect(page.channels.map((c) => c.id)).toEqual(["CB"]);
    expect(page.nextCursor).toBe(
      encodeChannelCursor({ openedAt: "2026-11-24T00:00:00.000Z", id: "CB" }),
    );
  });
});
