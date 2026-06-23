import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type CommitmentRecord,
  createReconciler,
  type DriftKind,
  type SettlementRecord,
} from "./index.js";

const reconciler = createReconciler();

/**
 * A pinned seed so a property failure in CI replays exactly when investigated
 * locally. Each fc.assert call below threads this seed through.
 *
 * See docs/design.md, "Testing": "Property tests on reconciliation: random
 * commitment streams must reconcile or flag deterministically."
 */
const SEED = 0x517fa72e;
const ASSERT_OPTS = { seed: SEED, numRuns: 200 };

// Arbitraries

const channelIdArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  .map((s) => `ch-${s}`);

/** Non-negative integer strings, the shape the channel manager produces. */
const amountStringArb = fc.bigInt({ min: 0n, max: 10_000_000_000n }).map((n) => n.toString());

/** Strings the AMOUNT_RE deliberately rejects. */
const malformedAmountArb = fc.oneof(
  fc.constant(""),
  fc.constant("1.5"),
  fc.constant("-1"),
  fc.constant("1e3"),
  fc.constant(" 100"),
  fc.constant("0x10"),
  fc.constantFrom("abc", "NaN", "Infinity"),
);

/**
 * An honest commitment stream paired with a matching settlement. Sequence
 * numbers are contiguous from 0, cumulativeAmount is monotonic non-decreasing,
 * settledAmount equals the final cumulative, returnedRemainder is any
 * non-negative integer.
 */
const honestStreamArb = fc
  .record({
    channelId: channelIdArb,
    deltas: fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), {
      minLength: 1,
      maxLength: 25,
    }),
    returnedRemainder: amountStringArb,
    txHash: fc.hexaString({ minLength: 8, maxLength: 64 }).map((h) => `0x${h}`),
  })
  .map(({ channelId, deltas, returnedRemainder, txHash }) => {
    const commitments: CommitmentRecord[] = [];
    let running = 0n;
    for (const [i, delta] of deltas.entries()) {
      running += delta;
      commitments.push({
        channelId,
        sequence: i,
        cumulativeAmount: running.toString(),
      });
    }
    const settlement: SettlementRecord = {
      channelId,
      settledAmount: running.toString(),
      returnedRemainder,
      txHash,
    };
    return { commitments, settlement, lastCumulative: running };
  });

function hasDrift(
  result: Awaited<ReturnType<typeof reconciler.reconcileChannel>>,
  kind: DriftKind,
): boolean {
  return result.ok === false && result.drift.some((d) => d.kind === kind);
}

// Honest path

describe("reconcileChannel property: honest path", () => {
  it("always returns ok for a contiguous, monotonic stream that matches its settlement", async () => {
    await fc.assert(
      fc.asyncProperty(honestStreamArb, async ({ commitments, settlement }) => {
        const result = await reconciler.reconcileChannel(commitments, settlement);
        return result.ok === true && result.channelId === settlement.channelId;
      }),
      ASSERT_OPTS,
    );
  });

  it("returns ok for the empty-stream / zero-settlement edge case", async () => {
    await fc.assert(
      fc.asyncProperty(channelIdArb, async (channelId) => {
        const settlement: SettlementRecord = {
          channelId,
          settledAmount: "0",
          returnedRemainder: "0",
          txHash: "0x00",
        };
        const result = await reconciler.reconcileChannel([], settlement);
        return result.ok === true;
      }),
      ASSERT_OPTS,
    );
  });

  it("ignores input order: the same stream shuffled produces the same outcome", async () => {
    await fc.assert(
      fc.asyncProperty(honestStreamArb, async ({ commitments, settlement }) => {
        const shuffled = [...commitments].reverse();
        const a = await reconciler.reconcileChannel(commitments, settlement);
        const b = await reconciler.reconcileChannel(shuffled, settlement);
        return a.ok === true && b.ok === true;
      }),
      ASSERT_OPTS,
    );
  });
});

// Inverse drift mapping
// One property per DriftKind. Each mutates an honest stream in exactly one way
// and asserts the targeted drift kind surfaces in the result.

describe("reconcileChannel property: inverse drift mapping", () => {
  it("under-settled fires when settledAmount is below lastCumulative", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb.filter((s) => s.lastCumulative > 0n),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        async ({ commitments, settlement, lastCumulative }, shortfall) => {
          const cappedShortfall = shortfall > lastCumulative ? lastCumulative : shortfall;
          const newSettled = lastCumulative - cappedShortfall;
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: newSettled.toString(),
            // Keep settled + remainder > 0 so unexpected-remainder cannot also fire.
            returnedRemainder: "1",
          };
          const result = await reconciler.reconcileChannel(commitments, mutated);
          return hasDrift(result, "under-settled");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("over-settled fires when settledAmount is above lastCumulative", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb,
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        async ({ commitments, settlement, lastCumulative }, excess) => {
          const newSettled = lastCumulative + excess;
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: newSettled.toString(),
          };
          const result = await reconciler.reconcileChannel(commitments, mutated);
          return hasDrift(result, "over-settled");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("missing-commitment fires for empty commitments with positive settlement", async () => {
    await fc.assert(
      fc.asyncProperty(
        channelIdArb,
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        async (channelId, settled) => {
          const settlement: SettlementRecord = {
            channelId,
            settledAmount: settled.toString(),
            returnedRemainder: "0",
            txHash: "0xabc",
          };
          const result = await reconciler.reconcileChannel([], settlement);
          return hasDrift(result, "missing-commitment");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("unexpected-remainder fires when settled + remainder is 0 but commitments exist", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb.filter((s) => s.lastCumulative > 0n),
        async ({ commitments, settlement }) => {
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: "0",
            returnedRemainder: "0",
          };
          const result = await reconciler.reconcileChannel(commitments, mutated);
          return hasDrift(result, "unexpected-remainder");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("sequence-gap fires when a middle sequence number is removed", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb.filter((s) => s.commitments.length >= 2),
        fc.integer({ min: 0, max: 1000 }),
        async ({ commitments, settlement }, pickRaw) => {
          // Drop a non-final entry so the remaining stream has a gap.
          const dropIndex = pickRaw % (commitments.length - 1);
          const withGap = commitments.filter((_, i) => i !== dropIndex);
          const result = await reconciler.reconcileChannel(withGap, settlement);
          return hasDrift(result, "sequence-gap");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("malformed-record fires when settledAmount is not a non-negative integer string", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb,
        malformedAmountArb,
        async ({ commitments, settlement }, badAmount) => {
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: badAmount,
          };
          const result = await reconciler.reconcileChannel(commitments, mutated);
          return hasDrift(result, "malformed-record");
        },
      ),
      ASSERT_OPTS,
    );
  });
});

// Composition: multiple defects in one stream surface all relevant drift kinds,
// not just the first. Guards against any short-circuit regression in the
// reconciler's drift-collection loop.

describe("reconcileChannel property: composition", () => {
  it("a sequence gap plus an under-settled total surface both drift kinds", async () => {
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb.filter((s) => s.commitments.length >= 2),
        fc.integer({ min: 0, max: 1000 }),
        async ({ commitments, settlement }, pickRaw) => {
          const dropIndex = pickRaw % (commitments.length - 1);
          const withGap = commitments.filter((_, i) => i !== dropIndex);
          const lastAfterGap = withGap[withGap.length - 1];
          if (!lastAfterGap) return true;
          const lastCumulativeAfterGap = BigInt(lastAfterGap.cumulativeAmount);
          if (lastCumulativeAfterGap === 0n) return true;
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: (lastCumulativeAfterGap - 1n).toString(),
            returnedRemainder: "1",
          };
          const result = await reconciler.reconcileChannel(withGap, mutated);
          return hasDrift(result, "sequence-gap") && hasDrift(result, "under-settled");
        },
      ),
      ASSERT_OPTS,
    );
  });

  it("an over-settled total alongside an unexpected-remainder condition cannot co-occur (sanity)", async () => {
    // Documents an invariant: unexpected-remainder requires settled + remainder
    // === 0, while over-settled requires settled > 0. They are mutually
    // exclusive on the same channel.
    await fc.assert(
      fc.asyncProperty(
        honestStreamArb.filter((s) => s.lastCumulative > 0n),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        async ({ commitments, settlement, lastCumulative }, excess) => {
          const mutated: SettlementRecord = {
            ...settlement,
            settledAmount: (lastCumulative + excess).toString(),
            returnedRemainder: "0",
          };
          const result = await reconciler.reconcileChannel(commitments, mutated);
          // Over-settled MUST fire; unexpected-remainder MUST NOT.
          return hasDrift(result, "over-settled") && !hasDrift(result, "unexpected-remainder");
        },
      ),
      ASSERT_OPTS,
    );
  });
});

// Exhaustiveness: if a new variant is added to the DriftKind union without an
// accompanying property below, this list will fall out of sync with the type
// and TypeScript will fail to compile the assertion. The static check is the
// point.

describe("reconcileChannel property: taxonomy", () => {
  it("the DriftKind union has the six members the property suite covers", () => {
    const covered: Record<DriftKind, true> = {
      "under-settled": true,
      "over-settled": true,
      "missing-commitment": true,
      "unexpected-remainder": true,
      "sequence-gap": true,
      "malformed-record": true,
    };
    expect(Object.keys(covered)).toHaveLength(6);
  });
});
