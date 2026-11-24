/**
 * The conformance suite every `CommitmentStore` runs (#179). Each case takes
 * a factory that returns a fresh, empty store, so the cases stay independent.
 * A case fails by throwing, so any test runner can host it:
 *
 * ```ts
 * for (const check of commitmentStoreConformanceCases) {
 *   it(check.name, () => check.run(() => createMyStore()));
 * }
 * ```
 *
 * The suite uses `node:assert` only, so it has no test-runner dependency and
 * is not part of the published build. See docs/channel-commitment-stores.md
 * for how to run it against a new backend.
 */

import assert from "node:assert/strict";
import { ChannelNotFoundError, CommitmentConflictError } from "../errors.js";
import type { CommitmentAppendExpectation, CommitmentStore } from "../store.js";
import type { Channel, ChannelListFilter, ChannelStatus, Commitment } from "../types.js";

export type CommitmentStoreFactory = () => CommitmentStore | Promise<CommitmentStore>;

export type ConformanceCase = {
  readonly name: string;
  run(makeStore: CommitmentStoreFactory): Promise<void>;
};

const MAX_I128 = (1n << 127n) - 1n;
const STATUSES: readonly ChannelStatus[] = [
  "open",
  "closing",
  "closed",
  "recovering",
  "recovered",
  "settlement-mismatched",
];

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    counterparty: "GRECIPIENT",
    asset: "USDC",
    deposit: "1000",
    committed: "0",
    sequence: -1,
    status: "open",
    network: "testnet",
    openTxHash: `tx-open-${id}`,
    openedAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

function commitmentFor(channelId: string, sequence: number, cumulativeAmount: string): Commitment {
  return { channelId, sequence, cumulativeAmount, commitment: `sig:${channelId}:${sequence}` };
}

function expectation(
  expectedSequence: number,
  expectedStatus: ChannelStatus = "open",
  lastCommitAt = "2026-11-24T01:00:00.000Z",
): CommitmentAppendExpectation {
  return { expectedSequence, expectedStatus, lastCommitAt };
}

/** Runs one write and names its outcome: "ok", "conflict:<field>" or "not-found". */
async function outcomeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof CommitmentConflictError) return `conflict:${error.field}`;
    if (error instanceof ChannelNotFoundError) return "not-found";
    throw error;
  }
}

/** Deterministic pseudo-random numbers, so a failing run can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function putAll(store: CommitmentStore, channels: readonly Channel[]): Promise<void> {
  for (const channel of channels) await store.putChannel(channel);
}

async function caseRoundTrip(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  const channel = makeChannel("CROUND", { lastCommitAt: "2026-11-24T00:30:00.000Z" });
  await store.putChannel(channel);
  assert.deepEqual(await store.getChannel("CROUND"), channel);
  assert.equal(await store.getChannel("CUNKNOWN"), undefined);
}

async function caseUpdateMerges(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CPATCH"));
  const updated = await store.updateChannel("CPATCH", { status: "closed", returnedRemainder: "7" });
  assert.equal(updated?.status, "closed");
  assert.equal(updated?.returnedRemainder, "7");
  assert.equal(updated?.counterparty, "GRECIPIENT", "unspecified fields keep their value");
  assert.equal(await store.updateChannel("CMISSING", { status: "closed" }), undefined);
}

async function caseOrdering(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CORDER"));
  for (let sequence = 0; sequence < 5; sequence += 1) {
    await store.appendCommitment(
      commitmentFor("CORDER", sequence, String((sequence + 1) * 10)),
      expectation(sequence - 1),
    );
  }
  const stream = await store.listCommitments("CORDER");
  assert.deepEqual(
    stream.map((c) => c.sequence),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(await store.listCommitments("CNONE"), []);
}

async function caseIsolation(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await putAll(store, [makeChannel("CISO1"), makeChannel("CISO2")]);
  await store.appendCommitment(commitmentFor("CISO1", 0, "5"), expectation(-1));
  await store.appendCommitment(commitmentFor("CISO2", 0, "9"), expectation(-1));
  assert.deepEqual(await store.listCommitments("CISO1"), [commitmentFor("CISO1", 0, "5")]);
  assert.deepEqual(await store.listCommitments("CISO2"), [commitmentFor("CISO2", 0, "9")]);
}

async function caseLargeAmounts(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  const max = MAX_I128.toString();
  await store.putChannel(makeChannel("CBIG", { deposit: max }));
  await store.appendCommitment(commitmentFor("CBIG", 0, max), expectation(-1));
  const channel = await store.getChannel("CBIG");
  assert.equal(channel?.committed, max);
  assert.equal(channel?.deposit, max);
  assert.equal((await store.listCommitments("CBIG"))[0]?.cumulativeAmount, max);
}

async function caseFilters(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await putAll(store, [
    makeChannel("CF-A", { status: "open", counterparty: "GA", asset: "USDC", network: "testnet" }),
    makeChannel("CF-B", { status: "closed", counterparty: "GA", asset: "XLM", network: "testnet" }),
    makeChannel("CF-C", { status: "open", counterparty: "GB", asset: "USDC", network: "mainnet" }),
    makeChannel("CF-D", { status: "open", counterparty: "GA", asset: "USDC", network: "mainnet" }),
  ]);
  const idsFor = async (filter: ChannelListFilter): Promise<string[]> =>
    (await store.listChannels(filter)).channels.map((c) => c.id);

  // Equal openedAt, so the id breaks the tie, descending.
  assert.deepEqual(await idsFor({}), ["CF-D", "CF-C", "CF-B", "CF-A"]);
  assert.deepEqual(await idsFor({ status: "open" }), ["CF-D", "CF-C", "CF-A"]);
  assert.deepEqual(await idsFor({ counterparty: "GA" }), ["CF-D", "CF-B", "CF-A"]);
  assert.deepEqual(await idsFor({ asset: "USDC" }), ["CF-D", "CF-C", "CF-A"]);
  assert.deepEqual(await idsFor({ network: "mainnet" }), ["CF-D", "CF-C"]);
  assert.deepEqual(
    await idsFor({ status: "open", counterparty: "GA", asset: "USDC", network: "mainnet" }),
    ["CF-D"],
  );
  assert.deepEqual(await idsFor({ counterparty: "GNOBODY" }), []);
}

async function caseOrder(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await putAll(store, [
    makeChannel("CO-1", { openedAt: "2026-11-24T00:00:01.000Z" }),
    makeChannel("CO-2", { openedAt: "2026-11-24T00:00:03.000Z" }),
    makeChannel("CO-3", { openedAt: "2026-11-24T00:00:02.000Z" }),
  ]);
  const page = await store.listChannels();
  assert.deepEqual(
    page.channels.map((c) => c.id),
    ["CO-2", "CO-3", "CO-1"],
    "newest openedAt first",
  );
}

async function casePaging(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await putAll(
    store,
    ["P1", "P2", "P3", "P4", "P5"].map((id) => makeChannel(id)),
  );

  const first = await store.listChannels({ limit: 2 });
  assert.deepEqual(
    first.channels.map((c) => c.id),
    ["P5", "P4"],
  );
  assert.ok(first.nextCursor, "a full page that is not the last has a cursor");

  // A status change between pages does not move the cursor.
  await store.updateChannel("P3", { status: "closing" });

  const second = await store.listChannels({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.channels.map((c) => c.id),
    ["P3", "P2"],
  );

  const last = await store.listChannels({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(
    last.channels.map((c) => c.id),
    ["P1"],
  );
  assert.equal(last.nextCursor, undefined, "the last page has no cursor");

  const filtered = await store.listChannels({ status: "open", limit: 2 });
  assert.deepEqual(
    filtered.channels.map((c) => c.id),
    ["P5", "P4"],
  );
  const filteredNext = await store.listChannels({
    status: "open",
    limit: 2,
    cursor: filtered.nextCursor,
  });
  assert.deepEqual(
    filteredNext.channels.map((c) => c.id),
    ["P2", "P1"],
  );
}

async function caseBadPageSize(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
    await assert.rejects(store.listChannels({ limit }), RangeError, `limit ${limit}`);
  }
  await assert.rejects(store.listChannels({ cursor: "not-a-cursor" }), RangeError);
}

async function caseStaleSequence(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CSTALE"));
  await store.appendCommitment(commitmentFor("CSTALE", 0, "40"), expectation(-1));
  const before = await store.getChannel("CSTALE");

  await assert.rejects(store.appendCommitment(commitmentFor("CSTALE", 0, "50"), expectation(-1)), {
    name: "CommitmentConflictError",
    field: "sequence",
  });
  assert.deepEqual(await store.getChannel("CSTALE"), before, "the record is unchanged");
  assert.deepEqual(await store.listCommitments("CSTALE"), [commitmentFor("CSTALE", 0, "40")]);
}

async function caseStaleStatus(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CSTATUS"));
  await store.transitionChannel("CSTATUS", "open", { status: "closing" });

  await assert.rejects(store.appendCommitment(commitmentFor("CSTATUS", 0, "1"), expectation(-1)), {
    name: "CommitmentConflictError",
    field: "status",
  });
  assert.deepEqual(await store.listCommitments("CSTATUS"), []);
}

async function caseNonFollowingCommitment(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CGAP"));
  await assert.rejects(store.appendCommitment(commitmentFor("CGAP", 5, "1"), expectation(-1)), {
    name: "CommitmentConflictError",
    field: "sequence",
  });
  assert.deepEqual(await store.listCommitments("CGAP"), []);
}

async function caseAppendUnknownChannel(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  assert.equal(
    await outcomeOf(() => store.appendCommitment(commitmentFor("CNOPE", 0, "1"), expectation(-1))),
    "not-found",
  );
}

async function caseConcurrentAppends(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CRACE"));
  // Every call starts before any is awaited, so they race for real.
  const attempts = Array.from({ length: 8 }, (_, i) =>
    store.appendCommitment(commitmentFor("CRACE", 0, String(10 + i)), expectation(-1)),
  );
  const results = await Promise.allSettled(attempts);
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, "exactly one append commits");
  for (const result of results) {
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof CommitmentConflictError, "the others get a conflict");
    }
  }
  const channel = await store.getChannel("CRACE");
  assert.equal(channel?.sequence, 0);
  const stream = await store.listCommitments("CRACE");
  assert.equal(stream.length, 1, "no commitment is written twice");
  assert.equal(channel?.committed, stream[0]?.cumulativeAmount);
}

async function caseTransition(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CTRANS"));
  const moved = await store.transitionChannel("CTRANS", "open", { status: "closing" });
  assert.equal(moved.status, "closing");
  assert.equal((await store.getChannel("CTRANS"))?.status, "closing");
}

async function caseStaleTransition(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CSTRANS", { status: "closing" }));
  await assert.rejects(store.transitionChannel("CSTRANS", "open", { status: "closed" }), {
    name: "CommitmentConflictError",
    field: "status",
    expected: "open",
    actual: "closing",
  });
  assert.equal((await store.getChannel("CSTRANS"))?.status, "closing");
}

async function caseConcurrentTransitions(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  await store.putChannel(makeChannel("CBOTH"));
  const results = await Promise.allSettled([
    store.transitionChannel("CBOTH", "open", { status: "closing" }),
    store.transitionChannel("CBOTH", "open", { status: "closing" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.getChannel("CBOTH"))?.status, "closing");
}

/** What the reference model says a write should do. */
type ModelChannel = {
  status: ChannelStatus;
  sequence: number;
  committed: string;
  lastCommitAt: string | undefined;
  stream: Commitment[];
};

async function caseReferenceModel(makeStore: CommitmentStoreFactory): Promise<void> {
  const store = await makeStore();
  const ids = ["CMODEL-1", "CMODEL-2", "CMODEL-3"];
  const model = new Map<string, ModelChannel>();
  for (const id of ids) {
    await store.putChannel(makeChannel(id));
    model.set(id, {
      status: "open",
      sequence: -1,
      committed: "0",
      lastCommitAt: undefined,
      stream: [],
    });
  }

  const random = seededRandom(0x5eed);
  const pick = (n: number): number => Math.floor(random() * n);
  // One id is never created, so some writes must report not-found.
  const allIds = [...ids, "CMODEL-GONE"];

  for (let step = 0; step < 400; step += 1) {
    const id = allIds[pick(allIds.length)] ?? "CMODEL-GONE";
    const current = model.get(id);

    if (random() < 0.6) {
      const expectedSequence = random() < 0.8 ? (current?.sequence ?? -1) : pick(4) - 1;
      const expectedStatus = random() < 0.85 ? "open" : (STATUSES[pick(STATUSES.length)] ?? "open");
      const sequence = random() < 0.9 ? expectedSequence + 1 : expectedSequence + pick(3);
      const commitment = commitmentFor(id, sequence, String(pick(1000)));
      const attempt = { expectedSequence, expectedStatus, lastCommitAt: `t-${step}` };

      let expected: string;
      if (!current) expected = "not-found";
      else if (current.status !== expectedStatus) expected = "conflict:status";
      else if (current.sequence !== expectedSequence) expected = "conflict:sequence";
      else if (commitment.sequence !== expectedSequence + 1) expected = "conflict:sequence";
      else {
        expected = "ok";
        current.committed = commitment.cumulativeAmount;
        current.sequence = commitment.sequence;
        current.lastCommitAt = attempt.lastCommitAt;
        current.stream.push(commitment);
      }

      const actual = await outcomeOf(() => store.appendCommitment(commitment, attempt));
      assert.equal(actual, expected, `step ${step}: append to ${id}`);
    } else {
      const expectedStatus = STATUSES[pick(STATUSES.length)] ?? "open";
      const next = STATUSES[pick(STATUSES.length)] ?? "open";
      let expected: string;
      if (!current) expected = "not-found";
      else if (current.status !== expectedStatus) expected = "conflict:status";
      else {
        expected = "ok";
        current.status = next;
      }
      const actual = await outcomeOf(() =>
        store.transitionChannel(id, expectedStatus, { status: next }),
      );
      assert.equal(actual, expected, `step ${step}: transition ${id}`);
    }
  }

  for (const id of ids) {
    const expected = model.get(id);
    const channel = await store.getChannel(id);
    assert.equal(channel?.status, expected?.status, `${id} status`);
    assert.equal(channel?.sequence, expected?.sequence, `${id} sequence`);
    assert.equal(channel?.committed, expected?.committed, `${id} committed`);
    assert.equal(channel?.lastCommitAt, expected?.lastCommitAt, `${id} lastCommitAt`);
    assert.deepEqual(await store.listCommitments(id), expected?.stream ?? []);
  }
}

/**
 * The cases, in the order a run reports them. Names are stable: a backend
 * can skip one by name only with a written reason in its own tests.
 */
export const commitmentStoreConformanceCases: readonly ConformanceCase[] = [
  {
    name: "round-trips a channel record through put and get",
    run: caseRoundTrip,
  },
  {
    name: "updateChannel merges the patch and resolves undefined for an unknown id",
    run: caseUpdateMerges,
  },
  {
    name: "lists commitments in sequence order",
    run: caseOrdering,
  },
  {
    name: "keeps the commitment streams of two channels apart",
    run: caseIsolation,
  },
  {
    name: "round-trips integer amounts up to 2^127 - 1 exactly",
    run: caseLargeAmounts,
  },
  {
    name: "lists channels with each filter",
    run: caseFilters,
  },
  {
    name: "pages channels in id order with a cursor",
    run: casePaging,
  },
  {
    name: "orders channels newest first by openedAt",
    run: caseOrder,
  },
  {
    name: "rejects a page size outside 1 to 200, or a cursor it did not issue",
    run: caseBadPageSize,
  },
  {
    name: "rejects a stale expected sequence and writes nothing",
    run: caseStaleSequence,
  },
  {
    name: "rejects a stale expected status on append and writes nothing",
    run: caseStaleStatus,
  },
  {
    name: "rejects a commitment that does not follow the expected sequence",
    run: caseNonFollowingCommitment,
  },
  {
    name: "reports an append to an unknown channel as not found",
    run: caseAppendUnknownChannel,
  },
  {
    name: "lets exactly one of N concurrent appends at one expected sequence succeed",
    run: caseConcurrentAppends,
  },
  {
    name: "applies a transition when the expected status matches",
    run: caseTransition,
  },
  {
    name: "rejects a stale expected status on transition and changes nothing",
    run: caseStaleTransition,
  },
  {
    name: "lets exactly one of two concurrent transitions win",
    run: caseConcurrentTransitions,
  },
  {
    name: "agrees with a reference model over a seeded run of mixed writes",
    run: caseReferenceModel,
  },
];
