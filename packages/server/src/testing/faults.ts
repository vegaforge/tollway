import type { SignedReceipt } from "@vegaforge/tollway-core";
import type { RedisLikeClient } from "../cache.js";
import type { FacilitatorClient } from "../facilitator.js";

/**
 * Test-only fault injection for the payment path. Every fault is data, so a
 * scenario reads as a script instead of a bespoke wrapper, and the invariant
 * checker at the bottom states in one place what the gate must never break.
 * Nothing here is exported from the package: a test imports it directly.
 *
 * Tests drive these with `vi.useFakeTimers()`, so a delay or a hang costs no
 * wall-clock time. See docs/failure-modes.md for the behaviour each scenario
 * pins down.
 */

/** One scripted answer for a single call. */
export type Fault =
  | { kind: "pass" }
  | { kind: "delay"; ms: number }
  /** Never settles: the call hangs until the caller stops waiting. */
  | { kind: "hang" }
  | { kind: "reject"; error: Error };

export const pass = (): Fault => ({ kind: "pass" });
export const delay = (ms: number): Fault => ({ kind: "delay", ms });
export const hang = (): Fault => ({ kind: "hang" });
export const rejectWith = (error: unknown): Fault => ({
  kind: "reject",
  error: error instanceof Error ? error : new Error(String(error)),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects or resolves a call according to its scripted fault. */
async function applyFault<T>(fault: Fault | undefined, run: () => Promise<T>): Promise<T> {
  if (!fault || fault.kind === "pass") {
    return run();
  }
  if (fault.kind === "delay") {
    await sleep(fault.ms);
    return run();
  }
  if (fault.kind === "hang") {
    return new Promise<T>(() => {
      // Deliberately never settles. The caller's deadline is what ends it.
    });
  }
  throw fault.error;
}

/** Scripted answers per facilitator operation, one entry per call. */
export type FacilitatorPlan = {
  verify?: readonly Fault[];
  settle?: readonly Fault[];
  supported?: readonly Fault[];
};

export type ScriptedFacilitator = FacilitatorClient & {
  readonly calls: { verify: number; settle: number; supported: number };
};

/**
 * Wraps a facilitator so its calls answer from a script. Once an operation's
 * script runs out, later calls go to the wrapped facilitator unchanged.
 */
export function scriptedFacilitator(
  inner: FacilitatorClient,
  plan: FacilitatorPlan = {},
): ScriptedFacilitator {
  const verifyScript = [...(plan.verify ?? [])];
  const settleScript = [...(plan.settle ?? [])];
  const supportedScript = [...(plan.supported ?? [])];
  const calls = { verify: 0, settle: 0, supported: 0 };

  return {
    calls,
    ...(inner.idempotencyKey ? { idempotencyKey: inner.idempotencyKey.bind(inner) } : {}),
    verify(input) {
      calls.verify += 1;
      return applyFault(verifyScript.shift(), () => inner.verify(input));
    },
    settle(input) {
      calls.settle += 1;
      return applyFault(settleScript.shift(), () => inner.settle(input));
    },
    supported() {
      calls.supported += 1;
      return applyFault(supportedScript.shift(), () => inner.supported());
    },
  };
}

/**
 * A facilitator that records what it was asked to settle: calls per nonce,
 * and the nonces whose settlement it reports as successful. The gate must
 * never make it see the same nonce settle twice.
 */
export type RecordingFacilitator = {
  readonly client: FacilitatorClient;
  readonly settleCalls: Map<string, number>;
  readonly settledNonces: Set<string>;
};

export function createRecordingFacilitator(inner: FacilitatorClient): RecordingFacilitator {
  const settleCalls = new Map<string, number>();
  const settledNonces = new Set<string>();
  const idempotencyKey = inner.idempotencyKey?.bind(inner);

  return {
    settleCalls,
    settledNonces,
    client: {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      verify: (input) => inner.verify(input),
      async settle(input) {
        settleCalls.set(input.nonce, (settleCalls.get(input.nonce) ?? 0) + 1);
        const result = await inner.settle(input);
        if (result.settled) settledNonces.add(input.nonce);
        return result;
      },
      supported: () => inner.supported(),
    },
  };
}

/** Scripted answers per store operation, one entry per call. */
export type RedisPlan = {
  get?: readonly Fault[];
  set?: readonly Fault[];
  eval?: readonly Fault[];
};

export type ScriptedRedis = RedisLikeClient & {
  readonly calls: { get: number; set: number; eval: number };
};

/**
 * Wraps a Redis-compatible client so its calls answer from a script. A `set`
 * script covers both the cache write and the `SET NX PX` lock acquisition,
 * which is how a hang during `acquire` is written.
 */
export function scriptedRedis(inner: RedisLikeClient, plan: RedisPlan = {}): ScriptedRedis {
  const getScript = [...(plan.get ?? [])];
  const setScript = [...(plan.set ?? [])];
  const evalScript = [...(plan.eval ?? [])];
  const calls = { get: 0, set: 0, eval: 0 };

  async function set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  async function set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<unknown>;
  async function set(
    key: string,
    value: string,
    mode: "EX" | "PX",
    ttl: number,
    condition?: "NX",
  ): Promise<unknown> {
    calls.set += 1;
    return applyFault(setScript.shift(), () =>
      mode === "EX"
        ? inner.set(key, value, "EX", ttl)
        : inner.set(key, value, "PX", ttl, condition ?? "NX"),
    );
  }

  return {
    calls,
    get(key) {
      calls.get += 1;
      return applyFault(getScript.shift(), () => inner.get(key));
    },
    set,
    eval(script, numKeys, ...keysAndArgs) {
      calls.eval += 1;
      return applyFault(evalScript.shift(), () => inner.eval(script, numKeys, ...keysAndArgs));
    },
  };
}

/**
 * Collects unhandled rejections while a scenario runs, so a test can fail on
 * one even though the assertion it would have broken already passed. Call
 * `stop` after every scenario promise has been awaited.
 */
export function watchUnhandledRejections(): { stop(): readonly Error[] } {
  const seen: Error[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  process.on("unhandledRejection", listener);
  return {
    stop() {
      process.off("unhandledRejection", listener);
      return seen;
    },
  };
}

/** One receipt the gate returned for a settled outcome. */
export type SettledReceipt = {
  /** Something that names the request in a failure message, such as the receipt id. */
  label: string;
  receipt: SignedReceipt;
};

/** A lock left in the store after a scenario. */
export type RemainingLock = {
  key: string;
  /** Redis `ttl` for the key, in milliseconds. `-1` means no expiry. */
  ttlMs: number;
};

export type InvariantInput = {
  /** Settle calls per payment nonce, as the facilitator saw them. */
  settles: ReadonlyMap<string, number>;
  /** The gate's in-flight map, which must be empty once requests finish. */
  inFlight: ReadonlyMap<string, unknown>;
  /** Receipts handed to a caller for a settled outcome. */
  settled: readonly SettledReceipt[];
  /** Checks the signature and shape of a receipt the gate returned. */
  verifies: (receipt: SignedReceipt) => Promise<boolean>;
  /** Locks still in the store. */
  locks: readonly RemainingLock[];
  /** The lock TTL the gate was configured with. */
  maxLockTtlMs: number;
};

/**
 * The invariant every scenario in gate.failure.test.ts must leave intact: a
 * payment settles at most once, every settled request carries a verifiable
 * receipt, no in-flight entry outlives its requests, and a lock left behind
 * is bounded by its TTL rather than held forever.
 */
export async function assertSettlementInvariants(input: InvariantInput): Promise<void> {
  const problems: string[] = [];
  for (const [nonce, calls] of input.settles) {
    if (calls > 1) {
      problems.push(`/settle was called ${calls} times for nonce ${nonce}`);
    }
  }
  if (input.inFlight.size > 0) {
    problems.push(`${input.inFlight.size} settlement(s) still in flight`);
  }
  for (const { label, receipt } of input.settled) {
    if (!(await input.verifies(receipt))) {
      problems.push(`the receipt ${label} returned to a caller does not verify`);
    }
  }
  for (const lock of input.locks) {
    if (lock.ttlMs <= 0 || lock.ttlMs > input.maxLockTtlMs) {
      problems.push(
        `lock ${lock.key} has a TTL of ${lock.ttlMs}ms, outside the configured ${input.maxLockTtlMs}ms`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`settlement invariants violated:\n- ${problems.join("\n- ")}`);
  }
}
