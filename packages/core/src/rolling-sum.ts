/**
 * Bucketed rolling-sum accumulator (Issue #192).
 *
 * Tracks the sum of `bigint` samples over a sliding time window, with a
 * fixed bucket granularity so memory is bounded: for a given window the
 * accumulator holds at most `ceil(windowMs / bucketMs) + 1` entries,
 * regardless of how many samples arrive.
 *
 * The accumulator over-counts by at most one bucket's worth of spend near
 * the window boundary, and never under-counts, so a cap built on top of
 * it fails closed. The error is documented in code comments and in
 * `apps/web/src/content/docs/policy.mdx`.
 *
 * Samples may arrive out of order, and a clock that steps backward only
 * over-counts. A clock that jumps forward and then returns is the one case
 * that under-counts, because the forward call prunes buckets for good; the
 * engine's daily reset has the same limit. Feed it a clock that does not
 * jump forward.
 *
 * Exported from `@vegaforge/tollway-core` so the budgeting work in #198
 * can reuse the same primitive instead of re-implementing it.
 */

const DEFAULT_BUCKET_COUNT = 60;

export type RollingSumOptions = {
  /** Length of the sliding window in milliseconds. Must be positive. */
  windowMs: number;
  /**
   * Resolution of one bucket in milliseconds. Must be positive and no
   * greater than `windowMs`. Defaults to `windowMs / 60`, clamped to at
   * least 1 ms. Smaller buckets mean finer approximation but a larger
   * in-memory map; the default (`windowMs/60`) is a good balance for
   * windows of a minute to a day.
   */
  bucketMs?: number;
};

/**
 * A small, well-tested accumulator that answers "how much was added in
 * the last window?" with bounded memory. Every method is synchronous; a
 * clock is passed in by the caller so the accumulator stays testable.
 */
export class RollingSum {
  readonly windowMs: number;
  readonly bucketMs: number;
  /** bucketIndex -> sum of samples whose timestamp fell in that bucket. */
  private readonly buckets = new Map<number, bigint>();

  constructor(options: RollingSumOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error(`RollingSum: windowMs must be positive, got ${options.windowMs}`);
    }
    const bucketMs =
      options.bucketMs ?? Math.max(1, Math.floor(options.windowMs / DEFAULT_BUCKET_COUNT));
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
      throw new Error(`RollingSum: bucketMs must be positive, got ${bucketMs}`);
    }
    if (bucketMs > options.windowMs) {
      throw new Error(
        `RollingSum: bucketMs (${bucketMs}) must be <= windowMs (${options.windowMs})`,
      );
    }
    this.windowMs = options.windowMs;
    this.bucketMs = bucketMs;
  }

  /** Index of the bucket a timestamp belongs to. */
  private bucketIndex(timestampMs: number): number {
    return Math.floor(timestampMs / this.bucketMs);
  }

  /** Records `amount` at `nowMs`. Also drops buckets older than the window. */
  add(nowMs: number, amount: bigint): void {
    this.prune(nowMs);
    const index = this.bucketIndex(nowMs);
    const previous = this.buckets.get(index) ?? 0n;
    this.buckets.set(index, previous + amount);
  }

  /**
   * Sum of every bucket whose end timestamp is still inside the window.
   * May include the leading edge of an about-to-expire bucket; that is
   * the bounded over-count the class guarantees against under-counting.
   */
  sum(nowMs: number): bigint {
    const cutoffIndex = this.bucketIndex(nowMs - this.windowMs);
    let total = 0n;
    for (const [index, bucketSum] of this.buckets) {
      // A bucket survives as long as any part of it is still within the
      // window; the boundary bucket is the one over-counted.
      if (index >= cutoffIndex) {
        total += bucketSum;
      }
    }
    return total;
  }

  /** Drops buckets older than `nowMs - windowMs`. Returns true if empty after pruning. */
  prune(nowMs: number): boolean {
    const cutoffIndex = this.bucketIndex(nowMs - this.windowMs);
    for (const index of this.buckets.keys()) {
      if (index < cutoffIndex) {
        this.buckets.delete(index);
      }
    }
    return this.buckets.size === 0;
  }

  /** True when no buckets contain samples (safe to evict from a parent map). */
  isEmpty(): boolean {
    return this.buckets.size === 0;
  }

  /** The number of active buckets. Bounded by `ceil(windowMs / bucketMs) + 1`. */
  get size(): number {
    return this.buckets.size;
  }
}
