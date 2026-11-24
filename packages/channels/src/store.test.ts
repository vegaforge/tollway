import { describe, expect, it } from "vitest";
import { createMemoryCommitmentStore } from "./store.js";
import type { Channel } from "./types.js";

/**
 * `listChannels` is what the service endpoints in #227 page through, so these
 * tests pin the ordering, the filters and the cursor contract: a page resumes
 * exactly after the last channel it returned, whatever changed in between.
 */

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const EURC = "CBEURCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function channel(id: string, openedAt: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    counterparty: "GCOUNTERPARTY",
    asset: USDC,
    deposit: "10000000",
    committed: "0",
    sequence: -1,
    status: "open",
    network: "testnet",
    openTxHash: `tx-open-${id}`,
    openedAt,
    ...overrides,
  };
}

const CHANNELS: readonly Channel[] = [
  channel("C1", "2026-01-01T00:00:00.000Z"),
  channel("C2", "2026-01-01T00:00:01.000Z"),
  channel("C3", "2026-01-01T00:00:02.000Z", { counterparty: "GOTHER", status: "closing" }),
  channel("C4", "2026-01-01T00:00:03.000Z", {
    counterparty: "GOTHER",
    asset: EURC,
    status: "closed",
  }),
  channel("C5", "2026-01-01T00:00:04.000Z", { counterparty: "GTHIRD", asset: EURC }),
];

async function seededStore(channels: readonly Channel[] = CHANNELS) {
  const store = createMemoryCommitmentStore();
  for (const item of channels) {
    await store.putChannel(item);
  }
  return store;
}

function ids(page: { channels: readonly Channel[] }): string[] {
  return page.channels.map((item) => item.id);
}

/** Walks every page and returns the ids, so a paging bug cannot hide. */
async function walk(
  store: ReturnType<typeof createMemoryCommitmentStore>,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await store.listChannels(cursor === undefined ? { limit } : { limit, cursor });
    seen.push(...ids(page));
    if (page.nextCursor === undefined) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

describe("CommitmentStore.listChannels", () => {
  it("lists every channel newest first", async () => {
    const store = await seededStore();
    const page = await store.listChannels();
    expect(ids(page)).toEqual(["C5", "C4", "C3", "C2", "C1"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("breaks a timestamp tie by id, descending", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const store = await seededStore([channel("C7", at), channel("C9", at)]);
    const page = await store.listChannels();
    expect(ids(page)).toEqual(["C9", "C7"]);
  });

  it("filters by status", async () => {
    const store = await seededStore();
    expect(ids(await store.listChannels({ status: "open" }))).toEqual(["C5", "C2", "C1"]);
    expect(ids(await store.listChannels({ status: "recovered" }))).toEqual([]);
  });

  it("filters by counterparty", async () => {
    const store = await seededStore();
    expect(ids(await store.listChannels({ counterparty: "GOTHER" }))).toEqual(["C4", "C3"]);
  });

  it("filters by asset and combines filters", async () => {
    const store = await seededStore();
    expect(ids(await store.listChannels({ asset: EURC }))).toEqual(["C5", "C4"]);
    expect(ids(await store.listChannels({ asset: EURC, status: "open" }))).toEqual(["C5"]);
    expect(
      ids(await store.listChannels({ asset: EURC, status: "open", counterparty: "GOTHER" })),
    ).toEqual([]);
  });

  it("pages with a cursor and stops on the last page", async () => {
    const store = await seededStore();
    const first = await store.listChannels({ limit: 2 });
    expect(ids(first)).toEqual(["C5", "C4"]);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await store.listChannels({ limit: 2, cursor: first.nextCursor });
    expect(ids(second)).toEqual(["C3", "C2"]);
    expect(second.nextCursor).toBeTypeOf("string");

    const third = await store.listChannels({ limit: 2, cursor: second.nextCursor });
    expect(ids(third)).toEqual(["C1"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("returns every channel exactly once across pages", async () => {
    const store = await seededStore();
    expect(await walk(store, 1)).toEqual(["C5", "C4", "C3", "C2", "C1"]);
    expect(await walk(store, 2)).toEqual(["C5", "C4", "C3", "C2", "C1"]);
    expect(await walk(store, 3)).toEqual(["C5", "C4", "C3", "C2", "C1"]);
  });

  it("keeps a cursor valid when a channel changes status between pages", async () => {
    const store = await seededStore();
    const first = await store.listChannels({ limit: 2 });
    expect(ids(first)).toEqual(["C5", "C4"]);

    // C3 moves out of the "closing" filter while the caller holds the cursor.
    // The cursor names a position, so the next page still resumes after C4.
    await store.updateChannel("C3", { status: "closed" });

    const second = await store.listChannels({ limit: 2, cursor: first.nextCursor });
    expect(ids(second)).toEqual(["C3", "C2"]);
  });

  it("applies filters across pages", async () => {
    const store = await seededStore();
    const first = await store.listChannels({ counterparty: "GOTHER", limit: 1 });
    expect(ids(first)).toEqual(["C4"]);
    const second = await store.listChannels({
      counterparty: "GOTHER",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(ids(second)).toEqual(["C3"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("returns an empty page when nothing matches", async () => {
    const store = createMemoryCommitmentStore();
    expect(await store.listChannels()).toEqual({ channels: [] });
  });

  it("rejects a limit outside 1 to 200", async () => {
    const store = await seededStore();
    for (const limit of [0, 201, -1, 1.5, Number.NaN]) {
      await expect(store.listChannels({ limit })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("rejects a cursor that is not a channel list cursor", async () => {
    const store = await seededStore();
    for (const cursor of ["not-a-cursor", Buffer.from("[1,2]").toString("base64url")]) {
      await expect(store.listChannels({ cursor })).rejects.toBeInstanceOf(RangeError);
    }
  });
});
