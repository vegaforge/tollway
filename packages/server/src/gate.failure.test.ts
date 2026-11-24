import {
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import {
  createHttpFacilitator,
  createMockFacilitator,
  type FacilitatorClient,
} from "./facilitator.js";
import {
  createPaywallWithInFlight,
  type GateOutcome,
  type InFlightSettlementResult,
  type PaywallConfig,
  type PaywallDeps,
  type TollwayRequest,
} from "./gate.js";
import { encodePaymentSignatureHeader, PAYMENT_SIGNATURE_HEADER } from "./headers.js";
import {
  assertSettlementInvariants,
  createRecordingFacilitator,
  delay,
  hang,
  type InvariantInput,
  pass,
  type RemainingLock,
  rejectWith,
  type SettledReceipt,
  scriptedFacilitator,
  scriptedRedis,
  watchUnhandledRejections,
} from "./testing/faults.js";

/**
 * Failure injection for the gate. Each scenario scripts one upstream fault,
 * runs the requests, and ends with the invariant checker: a payment settles
 * at most once, every settled request carries a receipt that verifies, the
 * in-flight map is empty, and any lock left behind is bounded by its TTL.
 * The outcomes asserted here are the ones documented in
 * docs/failure-modes.md.
 */

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

const baseRequest: TollwayRequest = {
  method: "GET",
  url: "/quotes/latest",
  headers: {},
};

const transaction = "mock-signed-auth-entry-failure";

const headers: Record<string, string> = {
  [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  }),
};

const paidRequest: TollwayRequest = { ...baseRequest, headers };

// Captured before any test fakes the timers: real event-loop turns let
// WebCrypto work (nonce digests, receipt signing) finish between fake ticks.
const realSetImmediate = globalThis.setImmediate;

/** Yields to the real event loop until `condition` holds. */
async function untilReal(condition: () => boolean): Promise<void> {
  for (let turns = 0; !condition(); turns += 1) {
    if (turns > 10_000) throw new Error("condition never held");
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

type MockRedis = InstanceType<typeof RedisMock>;

/**
 * Moves the fake clock forward half a second at a time, letting real WebCrypto
 * work finish between steps, until `condition` holds or `limitMs` of fake
 * time has passed.
 */
async function driveUntil(condition: () => boolean, limitMs: number): Promise<void> {
  const stepMs = 500;
  for (let elapsed = 0; !condition(); elapsed += stepMs) {
    if (elapsed > limitMs) throw new Error(`condition did not hold within ${limitMs}ms`);
    await vi.advanceTimersByTimeAsync(stepMs);
    await untilReal(() => true);
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

const LOCK_TTL_MS = 30_000;
const DEADLINE_MS = 15_000;
const HOLD_MS = 120_000;

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("failure-test-key");
  verifier = Ed25519Verifier.forSigner(signer);
});

let rejections: { stop(): readonly Error[] };
beforeEach(() => {
  rejections = watchUnhandledRejections();
});
afterEach(() => {
  // A floating promise on the payment path is a defect, not a test detail.
  expect(rejections.stop()).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One gate process: its gate, its in-flight map, and the store it shares. */
type GateProcess = {
  gate: (request: TollwayRequest) => Promise<GateOutcome>;
  inFlight: Map<string, Promise<InFlightSettlementResult>>;
};

function gateProcess(
  facilitator: FacilitatorClient,
  cache: SettlementCache | undefined,
  extra: Partial<PaywallDeps> = {},
): GateProcess {
  const inFlight = new Map<string, Promise<InFlightSettlementResult>>();
  const gate = createPaywallWithInFlight(
    config,
    {
      signer,
      facilitator,
      ...(cache ? { cache } : {}),
      settlementLockTtlMs: LOCK_TTL_MS,
      facilitatorTimeoutMs: DEADLINE_MS,
      ambiguousSettlementHoldMs: HOLD_MS,
      ...extra,
    },
    inFlight,
  );
  return { gate, inFlight };
}

function redisCache(redis: MockRedis, keyPrefix: string): SettlementCache {
  return createRedisSettlementCache({ client: redis as unknown as RedisLikeClient, keyPrefix });
}

function locksLeft(redis: MockRedis, keyPrefix: string): Promise<RemainingLock[]> {
  return redis.keys(`${keyPrefix}lock:*`).then(async (keys) => {
    const results: RemainingLock[] = [];
    for (const key of keys) {
      results.push({ key, ttlMs: await redis.pttl(key) });
    }
    return results;
  });
}

/**
 * Collects every settled outcome the scenario's requests returned, then runs
 * the invariant checker over all processes the scenario created.
 */
function invariantHarness(...processes: GateProcess[]) {
  const settled: SettledReceipt[] = [];
  return {
    record(outcome: GateOutcome): GateOutcome {
      if (outcome.kind === "settled") {
        settled.push({ label: outcome.receipt.receipt.id, receipt: outcome.receipt });
      }
      return outcome;
    },
    async check(settles: ReadonlyMap<string, number>, locks: readonly RemainingLock[] = []) {
      const inFlight = new Map<string, unknown>();
      for (const [index, process] of processes.entries()) {
        for (const [key, value] of process.inFlight) inFlight.set(`${index}:${key}`, value);
      }
      const input: InvariantInput = {
        settles,
        inFlight,
        settled,
        locks,
        maxLockTtlMs: LOCK_TTL_MS,
        verifies: async (receipt: SignedReceipt) => (await verifyReceipt(receipt, verifier)).valid,
      };
      await assertSettlementInvariants(input);
    },
  };
}

/**
 * Signing a receipt uses the real WebCrypto pool, which fake timers do not
 * drive. After the fake clock has moved past a late answer, switch to real
 * timers and wait for the work the gate scheduled to finish.
 */
async function settleBackgroundWork(condition: () => void): Promise<void> {
  vi.useRealTimers();
  await vi.waitFor(condition);
}

/** An error whose cause chain says the connection was refused before sending. */
function refusedConnection(): TollwayError {
  const socket = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  return new TollwayError("payment-failed", "facilitator /settle request failed: fetch failed", {
    cause: new TypeError("fetch failed", { cause: socket }),
  });
}

describe("facilitator faults", () => {
  it("answers 503 without settling when /verify hangs", async () => {
    vi.useFakeTimers();
    const recording = createRecordingFacilitator(createMockFacilitator());
    const facilitator = scriptedFacilitator(recording.client, { verify: [hang()] });
    const process = gateProcess(facilitator, createInMemorySettlementCache());
    const harness = invariantHarness(process);

    const pending = process.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      kind: "rejected",
      status: 503,
      reason: expect.stringContaining("facilitator-timeout"),
    });
    expect(recording.settleCalls.size).toBe(0);
    await harness.check(recording.settleCalls);
  });

  it("propagates a transport failure from /verify and never settles", async () => {
    const recording = createRecordingFacilitator(createMockFacilitator());
    const failure = new Error("socket hang up");
    const facilitator = scriptedFacilitator(recording.client, { verify: [rejectWith(failure)] });
    const process = gateProcess(facilitator, createInMemorySettlementCache());
    const harness = invariantHarness(process);

    await expect(process.gate(paidRequest)).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
    await harness.check(recording.settleCalls);
  });

  it("refuses a malformed /verify body from an HTTP facilitator and never settles", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ isValid: "yes", payer: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const process = gateProcess(
      createHttpFacilitator("https://facilitator.test"),
      createInMemorySettlementCache(),
    );
    const harness = invariantHarness(process);

    await expect(process.gate(paidRequest)).rejects.toMatchObject({ code: "payment-failed" });
    expect(calls).toEqual(["/verify"]);
    await harness.check(new Map());
  });

  it("answers 503 and holds the payment while a hung /settle may still land", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-hang:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [hang()] }),
    );
    const a = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const b = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    const pending = a.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "rejected", status: 503 });
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toContain("settlement-unknown");
      // The hold is the retry window.
      expect(outcome.headers?.["retry-after"]).toBe(String(HOLD_MS / 1000));
    }

    // Retries in either process, even long after the lock TTL, never reach
    // /settle while the first call may still land.
    expect(await a.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 503 });
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS * 2);
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.get(nonceOf(recording))).toBe(1);

    // Once the hold ends, the slot and the lock are freed.
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("holds the payment when /settle fails after the request was sent", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-sent:";
    const failure = new TollwayError("payment-failed", "facilitator /settle request failed", {
      cause: new Error("socket hang up"),
    });
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [rejectWith(failure)] }),
    );
    const a = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const b = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    await expect(a.gate(paidRequest)).rejects.toBe(failure);
    // A retry in the same process shares the failed attempt; one in another
    // process finds the lock still held. Neither settles again.
    await expect(a.gate(paidRequest)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS * 2);
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.get(nonceOf(recording))).toBe(1);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
    await harness.check(recording.settleCalls, []);
  });

  it("releases the payment at once when /settle was refused before sending", async () => {
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-refused:";
    const failure = refusedConnection();
    // The refusal happens before the facilitator sees the request, so the
    // recording facilitator sits behind the fault and never counts it.
    const recording = createRecordingFacilitator(createMockFacilitator());
    const facilitator = scriptedFacilitator(recording.client, { settle: [rejectWith(failure)] });
    const process = gateProcess(facilitator, redisCache(redis, keyPrefix));
    const harness = invariantHarness(process);

    await expect(process.gate(paidRequest)).rejects.toBe(failure);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
    expect(harness.record(await process.gate(paidRequest)).kind).toBe("settled");
    expect(facilitator.calls.settle).toBe(2);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("holds the payment when the HTTP transport deadline fires before the gate's", async () => {
    vi.useFakeTimers();
    // @x402/core uses AbortSignal.timeout, which fake timers do not drive.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const settleCalls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/verify") {
        return Promise.resolve(
          new Response(JSON.stringify({ isValid: true, payer: "GPAYER" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      settleCalls.push(path);
      // The request reached the facilitator and then hung.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const redis = new RedisMock();
    const keyPrefix = "failure:transport-deadline:";
    const facilitator = createHttpFacilitator("https://facilitator.test", { timeoutMs: 1_000 });
    const a = gateProcess(facilitator, redisCache(redis, keyPrefix));
    const b = gateProcess(facilitator, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    const first = a.gate(paidRequest);
    const expectation = expect(first).rejects.toMatchObject({ code: "payment-failed" });
    await untilReal(() => settleCalls.length === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
    expect(settleCalls).toEqual(["/settle"]);

    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS * 2);
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(settleCalls).toEqual(["/settle"]);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await harness.check(
      new Map([["settle", settleCalls.length]]),
      await locksLeft(redis, keyPrefix),
    );
  });

  it("records a payment that settled after the deadline so a retry replays it", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:late-settle:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(DEADLINE_MS + 5_000)] }),
    );
    const process = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(process);

    const pending = process.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await pending).toMatchObject({ kind: "rejected", status: 503 });
    expect(recording.settledNonces.size).toBe(0);

    // The abandoned /settle lands late: its receipt is recorded and the hold
    // ends early, so the payer collects it instead of paying again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recording.settledNonces.size).toBe(1);
    await settleBackgroundWork(() => expect(process.inFlight.size).toBe(0));
    const retry = harness.record(await process.gate(paidRequest));
    expect(retry.kind).toBe("settled");
    if (retry.kind === "settled") expect(retry.replayed).toBe(true);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("answers 502 when /settle reports failure, caches nothing and frees the payment", async () => {
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-declined:";
    const inner = createMockFacilitator();
    const recording = createRecordingFacilitator({
      ...inner,
      async settle() {
        return { settled: false, reason: "insufficient funds on chain" };
      },
    });
    const process = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(process);

    expect(await process.gate(paidRequest)).toEqual({
      kind: "rejected",
      status: 502,
      reason: "insufficient funds on chain",
    });
    expect(await redis.keys(`${keyPrefix}*`)).toEqual([]);
    await harness.check(recording.settleCalls, []);
  });

  it("settles normally while /supported fails, since the gate never calls it", async () => {
    const recording = createRecordingFacilitator(createMockFacilitator());
    const facilitator = scriptedFacilitator(recording.client, {
      supported: [rejectWith(new Error("supported unavailable"))],
    });
    await expect(facilitator.supported()).rejects.toThrow("supported unavailable");
    const process = gateProcess(facilitator, createInMemorySettlementCache());
    const harness = invariantHarness(process);

    expect(harness.record(await process.gate(paidRequest)).kind).toBe("settled");
    expect(facilitator.calls.supported).toBe(1);
    await harness.check(recording.settleCalls);
  });
});

describe("hold configuration and reporting", () => {
  it("refuses a hold that is not longer than the facilitator deadline", () => {
    for (const ambiguousSettlementHoldMs of [DEADLINE_MS, 1_000, 0, 1.5]) {
      expect(() =>
        gateProcess(createMockFacilitator(), undefined, { ambiguousSettlementHoldMs }),
      ).toThrow(/ambiguousSettlementHoldMs/);
    }
  });

  it("keeps holding, and never rejects unhandled, when a late receipt cannot be cached and the hook throws", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:late-write-fails:";
    const writeFailure = new Error("redis write failed");
    // set calls: the lock acquisition, then the late receipt write.
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      set: [pass(), rejectWith(writeFailure)],
    });
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(DEADLINE_MS + 1_000)] }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = gateProcess(recording.client, createRedisSettlementCache({ client, keyPrefix }), {
      onCacheError: () => {
        throw new Error("the operator hook is broken");
      },
    });
    const b = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    const first = a.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await first).toMatchObject({ kind: "rejected", status: 503 });
    await vi.advanceTimersByTimeAsync(1_000);
    await untilReal(() => logged.mock.calls.length > 0);
    expect(logged.mock.calls[0]?.[2]).toBe(writeFailure);

    // The payment landed but its receipt is not cached: the hold continues,
    // so a retry still cannot settle it a second time.
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.get(nonceOf(recording))).toBe(1);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });
});

describe("settlement cache faults", () => {
  it("fails closed with no settlement when Redis cannot answer get", async () => {
    const failure = new Error("redis get failed");
    const client = scriptedRedis(new RedisMock() as unknown as RedisLikeClient, {
      get: [rejectWith(failure)],
    });
    const recording = createRecordingFacilitator(createMockFacilitator());
    const process = gateProcess(recording.client, createRedisSettlementCache({ client }));
    const harness = invariantHarness(process);

    await expect(process.gate(paidRequest)).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
    await harness.check(recording.settleCalls);
  });

  it("fails closed with no settlement when the lock cannot be acquired", async () => {
    const failure = new Error("redis set failed");
    const client = scriptedRedis(new RedisMock() as unknown as RedisLikeClient, {
      set: [rejectWith(failure)],
    });
    const recording = createRecordingFacilitator(createMockFacilitator());
    const process = gateProcess(recording.client, createRedisSettlementCache({ client }));
    const harness = invariantHarness(process);

    await expect(process.gate(paidRequest)).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
    await harness.check(recording.settleCalls);
  });

  it("returns the receipt and reports a failed cache write after settlement", async () => {
    const writeFailure = new Error("redis write failed");
    const client = scriptedRedis(new RedisMock() as unknown as RedisLikeClient, {
      set: [pass(), rejectWith(writeFailure)],
    });
    const recording = createRecordingFacilitator(createMockFacilitator());
    const reported: Error[] = [];
    const process = gateProcess(recording.client, createRedisSettlementCache({ client }), {
      onCacheError: (error) => reported.push(error),
    });
    const harness = invariantHarness(process);

    const outcome = harness.record(await process.gate(paidRequest));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") expect(outcome.cacheError).toBe(writeFailure);
    expect(reported).toEqual([writeFailure]);
    await harness.check(recording.settleCalls);
  });

  it("replays the receipt and leaves a bounded lock when release fails", async () => {
    const redis = new RedisMock();
    const keyPrefix = "failure:release-fails:";
    const releaseFailure = new Error("redis eval failed");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      eval: [rejectWith(releaseFailure)],
    });
    const recording = createRecordingFacilitator(createMockFacilitator());
    const reported: Error[] = [];
    const process = gateProcess(
      recording.client,
      createRedisSettlementCache({ client, keyPrefix }),
      {
        onCacheError: (error) => reported.push(error),
      },
    );
    const harness = invariantHarness(process);

    const outcome = harness.record(await process.gate(paidRequest));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") expect(outcome.cacheError).toBe(releaseFailure);
    expect(reported).toEqual([releaseFailure]);

    // The receipt is cached, so a retry replays it without the lock.
    const retry = harness.record(await process.gate(paidRequest));
    expect(retry).toMatchObject({ kind: "settled", replayed: true });
    const locks = await locksLeft(redis, keyPrefix);
    expect(locks).toHaveLength(1);
    await harness.check(recording.settleCalls, locks);
  });

  // A lock nobody renews and nobody releases must free itself, so a dead
  // process costs at most one lock TTL of duplicate protection.
  it("frees a lock once its TTL passes", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:lock-ttl:";
    const cache = redisCache(redis, keyPrefix);
    const lock = await cache.acquire?.("x402:nonce", 100);
    expect(lock).toBeTruthy();
    if (!lock) return;

    await vi.advanceTimersByTimeAsync(200);
    // The holder's release after the TTL no longer owns the lock.
    expect(await cache.release?.("x402:nonce", lock)).toBe(false);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
  });

  it("reports a lock lost when Redis flaps between acquire and release", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:renew-flap:";
    const flap = new Error("redis flap");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      eval: [rejectWith(flap), pass()],
    });
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(LOCK_TTL_MS / 2)] }),
    );
    const reported: Error[] = [];
    const process = gateProcess(
      recording.client,
      createRedisSettlementCache({ client, keyPrefix }),
      {
        onCacheError: (error) => reported.push(error),
      },
    );
    const harness = invariantHarness(process);

    const pending = process.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(LOCK_TTL_MS / 2);
    await settleBackgroundWork(() => expect(process.inFlight.size).toBe(0));
    const outcome = await pending;

    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.lockLost).toBe(true);
      expect(outcome.cacheError).toBe(flap);
    }
    expect(reported).toContain(flap);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("reports a lock lost when Redis is slower than the lock TTL during settlement", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:redis-slow:";
    // A short TTL keeps the simulated run small; the ratios are what matter.
    const ttlMs = 3_000;
    // Every renewal, and the release, answers only after the lock expired.
    const slow = Array.from({ length: 8 }, () => delay(ttlMs * 2));
    const client = scriptedRedis(redis as unknown as RedisLikeClient, { eval: slow });
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(ttlMs + 500)] }),
    );
    const reported: Error[] = [];
    const process = gateProcess(
      recording.client,
      createRedisSettlementCache({ client, keyPrefix }),
      {
        settlementLockTtlMs: ttlMs,
        // The settle outlives the lock but not the gate's deadline here.
        facilitatorTimeoutMs: ttlMs * 2,
        onCacheError: (error) => reported.push(error),
      },
    );
    const harness = invariantHarness(process);

    let finished: GateOutcome | undefined;
    void process.gate(paidRequest).then((outcome) => {
      finished = harness.record(outcome);
    });
    await driveUntil(() => finished !== undefined, ttlMs * 6);

    expect(finished).toMatchObject({ kind: "settled", lockLost: true });
    expect(reported.length).toBeGreaterThan(0);
    // The receipt was cached, so a retry replays it rather than settling.
    expect(harness.record(await process.gate(paidRequest))).toMatchObject({
      kind: "settled",
      replayed: true,
    });
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("treats a foreign value under the settlement key as a miss and settles once", async () => {
    const redis = new RedisMock();
    const keyPrefix = "failure:foreign:";
    const recording = createRecordingFacilitator(createMockFacilitator());
    const nonce = await createMockFacilitator().idempotencyKey?.({
      payment: {
        model: "x402",
        payload: {
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "stellar:testnet",
            asset: config.asset,
            amount: config.amount,
            payTo: config.payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: { transaction },
        },
      },
    });
    if (!nonce) throw new Error("the mock facilitator derives no nonce");
    // Another tenant, or a manual debug write, left a value the cache does
    // not recognise (the case cache.test.ts covers at the cache level).
    await redis.set(`${keyPrefix}x402:${nonce}`, JSON.stringify({ hello: "world" }), "EX", 30);
    const process = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(process);

    expect(harness.record(await process.gate(paidRequest)).kind).toBe("settled");
    expect(harness.record(await process.gate(paidRequest))).toMatchObject({
      kind: "settled",
      replayed: true,
    });
    expect(recording.settleCalls.get(nonce)).toBe(1);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });
});

describe("two gate processes sharing one Redis", () => {
  it("never settles twice when a retry arrives after the lock TTL while /settle still runs", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:retry-after-ttl:";
    // The first /settle takes a minute: longer than the gate's deadline and
    // longer than the lock TTL.
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(60_000)] }),
    );
    const a = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const b = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    const first = a.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await first).toMatchObject({ kind: "rejected", status: 503 });

    // 46 s in: past the lock TTL counted from the deadline. The retry in the
    // other process must not reach /settle while the first may still land.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.get(nonceOf(recording))).toBe(1);

    // The first /settle lands at 60 s: its receipt is recorded and the lock
    // freed, so the retry now replays it.
    await vi.advanceTimersByTimeAsync(14_000);
    await settleBackgroundWork(() => expect(a.inFlight.size).toBe(0));
    await vi.waitFor(async () => expect(await locksLeft(redis, keyPrefix)).toEqual([]));
    expect(harness.record(await b.gate(paidRequest))).toMatchObject({
      kind: "settled",
      replayed: true,
    });
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("answers 409 in the second process while the first waits on a hung /settle", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:multi-process:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [hang()] }),
    );
    const a = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const b = gateProcess(recording.client, redisCache(redis, keyPrefix));
    const harness = invariantHarness(a, b);

    const first = a.gate(paidRequest).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await first).toMatchObject({ kind: "rejected", status: 503 });
    expect(await b.gate(paidRequest)).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.get(nonceOf(recording))).toBe(1);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });
});

describe("owned by other issues", () => {
  it.todo(
    "#107: every adapter answers the 503 settlement-unknown and a thrown payment-failed the same way",
  );
  it.todo(
    "#161: the 503 for an ambiguous settlement carries a machine-readable code, and Retry-After is set in every adapter",
  );
  it.todo(
    "#162: a retry that arrives after the cached receipt expired is answered from a receipt archive instead of /verify",
  );
});

/** The single nonce a scenario's facilitator was asked to settle. */
function nonceOf(recording: { settleCalls: ReadonlyMap<string, number> }): string {
  const [nonce] = [...recording.settleCalls.keys()];
  if (nonce === undefined) throw new Error("no settlement was attempted");
  return nonce;
}
