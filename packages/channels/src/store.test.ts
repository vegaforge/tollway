import { describe, expect, it } from "vitest";
import { ChannelNotFoundError, CommitmentConflictError } from "./errors.js";
import { createMemoryCommitmentStore } from "./store.js";
import type { Channel, Commitment } from "./types.js";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "CCHAN",
    counterparty: "GR",
    asset: "USDC",
    deposit: "1000",
    committed: "0",
    sequence: -1,
    status: "open",
    network: "testnet",
    openTxHash: "tx-open",
    openedAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

function commitment(sequence: number, cumulativeAmount: string): Commitment {
  return { channelId: "CCHAN", sequence, cumulativeAmount, commitment: `sig-${sequence}` };
}

const expectation = (expectedSequence: number) => ({
  expectedSequence,
  expectedStatus: "open" as const,
  lastCommitAt: "2026-11-24T00:00:01.000Z",
});

describe("CommitmentStore.appendCommitment (compare-and-set)", () => {
  it("appends and advances committed, sequence and lastCommitAt together", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());

    const advanced = await store.appendCommitment(commitment(0, "40"), expectation(-1));

    expect(advanced).toMatchObject({
      committed: "40",
      sequence: 0,
      lastCommitAt: "2026-11-24T00:00:01.000Z",
    });
    expect(await store.getChannel("CCHAN")).toEqual(advanced);
    expect(await store.listCommitments("CCHAN")).toEqual([commitment(0, "40")]);
  });

  it("rejects a stale expected sequence and writes nothing", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());
    await store.appendCommitment(commitment(0, "40"), expectation(-1));
    const before = await store.getChannel("CCHAN");

    const attempt = store.appendCommitment(commitment(0, "50"), expectation(-1));

    await expect(attempt).rejects.toBeInstanceOf(CommitmentConflictError);
    await expect(attempt).rejects.toMatchObject({ field: "sequence", expected: "-1", actual: "0" });
    expect(await store.getChannel("CCHAN")).toEqual(before);
    expect(await store.listCommitments("CCHAN")).toEqual([commitment(0, "40")]);
  });

  it("rejects a commitment that does not follow the expected sequence", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());

    const attempt = store.appendCommitment(commitment(5, "40"), expectation(-1));
    await expect(attempt).rejects.toMatchObject({ field: "sequence", expected: "0", actual: "5" });
    expect(await store.listCommitments("CCHAN")).toEqual([]);
  });

  it("rejects a stale expected status and writes nothing", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());
    await store.transitionChannel("CCHAN", "open", { status: "closing" });

    const attempt = store.appendCommitment(commitment(0, "40"), expectation(-1));

    await expect(attempt).rejects.toMatchObject({ field: "status", actual: "closing" });
    expect(await store.listCommitments("CCHAN")).toEqual([]);
    expect((await store.getChannel("CCHAN"))?.sequence).toBe(-1);
  });

  it("reports an unknown channel as not found", async () => {
    const store = createMemoryCommitmentStore();
    const attempt = store.appendCommitment(commitment(0, "1"), expectation(-1));
    await expect(attempt).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it("lets exactly one of N concurrent appends at the same expected sequence succeed", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());

    const attempts = Array.from({ length: 8 }, (_, i) =>
      store.appendCommitment(commitment(0, String(10 + i)), expectation(-1)),
    );
    const results = await Promise.allSettled(attempts);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const losers = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(losers).toHaveLength(7);
    for (const loser of losers) expect(loser).toBeInstanceOf(CommitmentConflictError);
    expect(await store.listCommitments("CCHAN")).toHaveLength(1);
  });
});

describe("CommitmentStore.transitionChannel (compare-and-set)", () => {
  it("applies the patch when the expected status matches", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());

    const next = await store.transitionChannel("CCHAN", "open", { status: "closing" });

    expect(next.status).toBe("closing");
    expect((await store.getChannel("CCHAN"))?.status).toBe("closing");
  });

  it("rejects a stale expected status and leaves the record unchanged", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel({ status: "closing" }));

    const attempt = store.transitionChannel("CCHAN", "open", { status: "closed" });

    await expect(attempt).rejects.toMatchObject({
      field: "status",
      expected: "open",
      actual: "closing",
    });
    expect((await store.getChannel("CCHAN"))?.status).toBe("closing");
  });

  it("lets exactly one of two concurrent open-to-closing transitions win", async () => {
    const store = createMemoryCommitmentStore();
    await store.putChannel(channel());

    const results = await Promise.allSettled([
      store.transitionChannel("CCHAN", "open", { status: "closing" }),
      store.transitionChannel("CCHAN", "open", { status: "closing" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
