import { describe, expect, it } from "vitest";
import { type CommitmentStore, createMemoryCommitmentStore } from "./store.js";
import { commitmentStoreConformanceCases } from "./testing/store-conformance.js";
import type { Commitment } from "./types.js";

describe("CommitmentStore conformance: memory store", () => {
  for (const check of commitmentStoreConformanceCases) {
    it(check.name, async () => {
      await check.run(() => createMemoryCommitmentStore());
    });
  }
});

/**
 * A store whose append ignores the expected sequence and status, as a store
 * without compare-and-set would. The suite must reject it, or the suite
 * proves nothing.
 */
function createUnconditionalAppendStore(): CommitmentStore {
  const inner = createMemoryCommitmentStore();
  const streams = new Map<string, Commitment[]>();
  return {
    ...inner,
    async appendCommitment(commitment, expectation) {
      const stream = streams.get(commitment.channelId) ?? [];
      stream.push(commitment);
      streams.set(commitment.channelId, stream);
      const current = await inner.getChannel(commitment.channelId);
      if (!current) throw new Error(`unknown channel ${commitment.channelId}`);
      const next = {
        ...current,
        committed: commitment.cumulativeAmount,
        sequence: commitment.sequence,
        lastCommitAt: expectation.lastCommitAt,
      };
      await inner.updateChannel(commitment.channelId, next);
      return next;
    },
    async listCommitments(channelId) {
      return [...(streams.get(channelId) ?? [])].sort((a, b) => a.sequence - b.sequence);
    },
  };
}

describe("CommitmentStore conformance suite catches a broken store", () => {
  it("fails the compare-and-set cases for a store with unconditional appends", async () => {
    const outcomes = await Promise.allSettled(
      commitmentStoreConformanceCases.map((check) =>
        check.run(() => createUnconditionalAppendStore()),
      ),
    );
    const failed = commitmentStoreConformanceCases.filter(
      (_, i) => outcomes[i]?.status === "rejected",
    );
    const failedNames = failed.map((check) => check.name);

    expect(failedNames).toContain("rejects a stale expected sequence and writes nothing");
    expect(failedNames).toContain(
      "lets exactly one of N concurrent appends at one expected sequence succeed",
    );
    expect(failedNames).toContain(
      "agrees with a reference model over a seeded run of mixed writes",
    );
  });
});
