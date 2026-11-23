import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RollingSum } from "./rolling-sum.js";

/**
 * Issue #192 coverage for the shared rolling-sum accumulator.
 */

describe("RollingSum", () => {
  it("rejects a non-positive window", () => {
    expect(() => new RollingSum({ windowMs: 0 })).toThrow();
    expect(() => new RollingSum({ windowMs: -1 })).toThrow();
    expect(() => new RollingSum({ windowMs: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("rejects a bucket larger than the window", () => {
    expect(() => new RollingSum({ windowMs: 1000, bucketMs: 1001 })).toThrow();
  });

  it("sums only buckets whose end is still inside the window", () => {
    const sum = new RollingSum({ windowMs: 10_000, bucketMs: 1_000 });
    sum.add(1_000, 10n);
    sum.add(5_000, 20n);
    expect(sum.sum(5_500)).toBe(30n);

    // Advance so the sample at t=1_000 is just past the window end.
    // Its bucket (index 1, spans [1_000, 2_000)) is still partly
    // inside at t=12_500 - 10_000 = 2_500 > 1_999, so it is finally
    // dropped by `sum`. That is the documented bounded over-count the
    // next test pins down.
    expect(sum.sum(12_500)).toBe(20n);
  });

  it("over-counts by at most one bucket's worth (never under-counts)", () => {
    const sum = new RollingSum({ windowMs: 60_000, bucketMs: 10_000 });
    // All samples land in the same bucket as t=0 (bucket index 0).
    sum.add(0, 5n);
    sum.add(9_999, 7n);
    // At t=70_001, cutoff = 10_001ms => bucketIndex(10_001) = 1. Bucket 0 is
    // dropped. Expect zero.
    expect(sum.sum(70_001)).toBe(0n);
    // At t=69_999, cutoff = 9_999ms => bucketIndex(9_999) = 0. Bucket 0
    // survives even though parts of it are outside the window: that is
    // the documented one-bucket over-count. Caller sees the full 12n.
    expect(sum.sum(69_999)).toBe(12n);
  });

  it("prunes old buckets and reports emptiness", () => {
    const sum = new RollingSum({ windowMs: 1_000, bucketMs: 100 });
    sum.add(0, 5n);
    expect(sum.isEmpty()).toBe(false);
    sum.prune(2_000);
    expect(sum.isEmpty()).toBe(true);
    expect(sum.prune(3_000)).toBe(true);
  });

  it("holds at most ceil(windowMs/bucketMs)+1 buckets no matter how many samples arrive", () => {
    const sum = new RollingSum({ windowMs: 10_000, bucketMs: 1_000 });
    for (let t = 0; t < 1_000_000; t += 97) {
      sum.add(t, 1n);
    }
    // At t=1_000_000, buckets outside the last 10 seconds have been
    // pruned by `add` itself.
    expect(sum.size).toBeLessThanOrEqual(Math.ceil(10_000 / 1_000) + 1);
  });

  it("bucketed sum is always >= true windowed sum (never under-counts)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // Timestamps in a 24h window at millisecond granularity.
            ts: fc.integer({ min: 0, max: 24 * 60 * 60 * 1_000 }),
            amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
          }),
          { minLength: 0, maxLength: 200 },
        ),
        (samples) => {
          const windowMs = 60 * 60 * 1_000; // one hour
          const bucketMs = 5 * 60 * 1_000; // five minutes
          const rolling = new RollingSum({ windowMs, bucketMs });

          // Feed samples in timestamp order so the accumulator receives
          // them monotonically (its add() contract).
          const ordered = [...samples].sort((a, b) => a.ts - b.ts);
          for (const sample of ordered) {
            rolling.add(sample.ts, sample.amount);
          }
          const nowMs = ordered.at(-1)?.ts ?? 0;

          // True windowed sum over the last hour from nowMs.
          const cutoff = nowMs - windowMs;
          let trueSum = 0n;
          for (const sample of ordered) {
            if (sample.ts > cutoff) trueSum += sample.amount;
          }

          const observed = rolling.sum(nowMs);
          // Bounded over-count: at most one bucket's worth of samples
          // can be included past the true window edge.
          let boundaryBucketAmount = 0n;
          const boundaryBucketIndex = Math.floor(cutoff / bucketMs);
          for (const sample of ordered) {
            if (Math.floor(sample.ts / bucketMs) === boundaryBucketIndex) {
              boundaryBucketAmount += sample.amount;
            }
          }
          expect(observed >= trueSum).toBe(true);
          expect(observed <= trueSum + boundaryBucketAmount).toBe(true);
        },
      ),
      { numRuns: 200, seed: 192 },
    );
  });

  it("never under-counts when samples arrive out of order", () => {
    // Clocks on different hosts, or a clock stepped back by NTP, deliver
    // timestamps out of order. Querying at the latest time seen must still
    // count every sample inside the window.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ts: fc.integer({ min: 0, max: 6 * 60 * 60 * 1_000 }),
            amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (samples) => {
          const windowMs = 60 * 60 * 1_000;
          const rolling = new RollingSum({ windowMs, bucketMs: 60 * 1_000 });
          for (const sample of samples) {
            rolling.add(sample.ts, sample.amount);
          }
          const nowMs = Math.max(...samples.map((sample) => sample.ts));
          let trueSum = 0n;
          for (const sample of samples) {
            if (sample.ts > nowMs - windowMs) trueSum += sample.amount;
          }
          expect(rolling.sum(nowMs) >= trueSum).toBe(true);
        },
      ),
      { numRuns: 200, seed: 1921 },
    );
  });

  it("keeps counting later samples when the clock steps backward", () => {
    // A backward step over-counts: buckets stamped in the "future" stay in
    // the sum, so a cap built on it refuses rather than allows.
    const rolling = new RollingSum({ windowMs: 60_000, bucketMs: 1_000 });
    rolling.add(100_000, 70n);
    expect(rolling.sum(50_000)).toBe(70n);
    expect(rolling.prune(50_000)).toBe(false);
  });
});
