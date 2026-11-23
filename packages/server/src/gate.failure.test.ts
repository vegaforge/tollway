import {
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createPaywall,
  createPaywallWithInFlight,
  type GateOutcome,
  type InFlightSettlementResult,
  type PaywallConfig,
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
 * runs the request, and checks the rule from AGENTS.md: a payment settles at
 * most once, and no request returns a resource without a receipt. The
 * outcomes asserted here are the ones documented in docs/failure-modes.md.
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

function paymentHeaders(): Record<string, string> {
  return {
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
}

const headers = paymentHeaders();

let signer: Ed25519Signer;
const verifier = { current: undefined as Ed25519Verifier | undefined };

beforeAll(async () => {
  signer = await Ed25519Signer.generate("failure-test-key");
  verifier.current = Ed25519Verifier.forSigner(signer);
});

/** The shared in-flight map a gate would use inside one process. */
function newInFlight(): Map<string, Promise<InFlightSettlementResult>> {
  return new Map();
}

/** Every scenario checks the same invariants; this collects their inputs. */
function invariantHarness(inFlight: ReadonlyMap<string, unknown>) {
  const settled: SettledReceipt[] = [];
  return {
    settled,
    record(outcome: GateOutcome): GateOutcome {
      if (outcome.kind === "settled") {
        settled.push({ label: outcome.receipt.receipt.id, receipt: outcome.receipt });
      }
      return outcome;
    },
    async check(settles: ReadonlyMap<string, number>, locks: readonly RemainingLock[] = []) {
      const receiptVerifier = verifier.current;
      if (!receiptVerifier) throw new Error("verifier was not built");
      const input: InvariantInput = {
        settles,
        inFlight,
        settled,
        locks,
        maxLockTtlMs: 30_000,
        verifies: async (receipt: SignedReceipt) =>
          (await verifyReceipt(receipt, receiptVerifier)).valid,
      };
      await assertSettlementInvariants(input);
    },
  };
}

let rejections: { stop(): readonly Error[] };
beforeEach(() => {
  rejections = watchUnhandledRejections();
});
afterEach(() => {
  // A floating promise on the payment path is a defect, not a test detail.
  expect(rejections.stop()).toEqual([]);
  vi.useRealTimers();
});

function locksLeft(redis: unknown, keyPrefix: string): Promise<RemainingLock[]> {
  // ioredis-mock exposes inspection helpers the duck-typed client does not.
  const store = redis as {
    keys(pattern: string): Promise<string[]>;
    pttl(key: string): Promise<number>;
  };
  return store.keys(`${keyPrefix}lock:*`).then(async (keys) => {
    const results: RemainingLock[] = [];
    for (const key of keys) {
      results.push({ key, ttlMs: await store.pttl(key) });
    }
    return results;
  });
}

describe("facilitator faults", () => {
  it("answers 503 without settling when /verify hangs", async () => {
    vi.useFakeTimers();
    try {
      const inner = createMockFacilitator();
      const recording = createRecordingFacilitator(inner);
      const facilitator = scriptedFacilitator(recording.client, { verify: [hang()] });
      const inFlight = newInFlight();
      const gate = createPaywallWithInFlight(
        config,
        {
          signer,
          facilitator,
          cache: createInMemorySettlementCache(),
          facilitatorTimeoutMs: 1_000,
        },
        inFlight,
      );
      const harness = invariantHarness(inFlight);

      const pending = gate({ ...baseRequest, headers }).then((outcome) => harness.record(outcome));
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({
        kind: "rejected",
        status: 503,
        reason: expect.stringContaining("facilitator-timeout"),
      });
      expect(recording.settleCalls.size).toBe(0);
      await harness.check(recording.settleCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a transport failure from /verify and never settles", async () => {
    const inner = createMockFacilitator();
    const recording = createRecordingFacilitator(inner);
    const failure = new Error("socket hang up");
    const facilitator = scriptedFacilitator(recording.client, { verify: [rejectWith(failure)] });
    const inFlight = newInFlight();
    const gate = createPaywallWithInFlight(
      config,
      { signer, facilitator, cache: createInMemorySettlementCache() },
      inFlight,
    );

    await expect(gate({ ...baseRequest, headers })).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
    expect(inFlight.size).toBe(0);
  });

  it("answers 503 and holds the lock when /settle hangs", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-hang:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [hang()] }),
    );
    const facilitator = recording.client;
    const inFlight = newInFlight();
    const gate = createPaywallWithInFlight(
      config,
      {
        signer,
        facilitator,
        cache: createRedisSettlementCache({
          client: redis as unknown as RedisLikeClient,
          keyPrefix,
        }),
        facilitatorTimeoutMs: 1_000,
      },
      inFlight,
    );
    const harness = invariantHarness(inFlight);

    const pending = gate({ ...baseRequest, headers }).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ kind: "rejected", status: 503 });
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toContain("settlement-unknown");
      // The lock TTL is the retry window.
      expect(outcome.headers?.["retry-after"]).toBe("30");
    }
    expect(recording.settleCalls.size).toBe(1);

    // A retry of the same payment must not reach /settle while the first
    // call may still land; it gets the same retriable answer.
    const retry = await gate({ ...baseRequest, headers });
    expect(retry).toMatchObject({ kind: "rejected", status: 503 });
    if (retry.kind === "rejected") expect(retry.reason).toContain("settlement-unknown");
    expect(recording.settleCalls.size).toBe(1);

    // Once the lock TTL passes, the ambiguity window is over and the slot is
    // freed.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inFlight.size).toBe(0);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("releases the lock when /settle rejects", async () => {
    const redis = new RedisMock();
    const keyPrefix = "failure:settle-reject:";
    const failure = new Error("facilitator unavailable");
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [rejectWith(failure)] }),
    );
    const facilitator = recording.client;
    const gate = createPaywall(config, {
      signer,
      facilitator,
      cache: createRedisSettlementCache({ client: redis as unknown as RedisLikeClient, keyPrefix }),
    });

    await expect(gate({ ...baseRequest, headers })).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(1);
    expect(await locksLeft(redis, keyPrefix)).toEqual([]);
  });

  it("records a payment that settled after the deadline so a retry replays it", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:late-settle:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [delay(5_000)] }),
    );
    const facilitator = recording.client;
    const inFlight = newInFlight();
    const gate = createPaywallWithInFlight(
      config,
      {
        signer,
        facilitator,
        cache: createRedisSettlementCache({
          client: redis as unknown as RedisLikeClient,
          keyPrefix,
        }),
        facilitatorTimeoutMs: 1_000,
      },
      inFlight,
    );
    const harness = invariantHarness(inFlight);

    const pending = gate({ ...baseRequest, headers }).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ kind: "rejected", status: 503 });
    expect(recording.settledNonces.size).toBe(0);

    // The abandoned /settle lands late: its receipt is recorded, so the
    // payer can collect it instead of paying again. Signing the late receipt
    // uses the real crypto pool, so wait for the slot to be freed.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recording.settledNonces.size).toBe(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(inFlight.size).toBe(0));
    const retry = await gate({ ...baseRequest, headers });
    harness.record(retry);
    expect(retry.kind).toBe("settled");
    if (retry.kind === "settled") expect(retry.replayed).toBe(true);
    expect(recording.settleCalls.size).toBe(1);
    expect(inFlight.size).toBe(0);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });

  it("answers 502 when /settle reports failure and caches nothing", async () => {
    const inner = createMockFacilitator();
    const recording = createRecordingFacilitator(inner);
    const facilitator = scriptedFacilitator(recording.client, {
      settle: [{ kind: "pass" }],
    });
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...facilitator,
        async settle() {
          return { settled: false, reason: "insufficient funds on chain" };
        },
      },
      cache: createInMemorySettlementCache(),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome).toEqual({
      kind: "rejected",
      status: 502,
      reason: "insufficient funds on chain",
    });
  });
});

describe("settlement cache faults", () => {
  it("fails closed with no settlement when Redis cannot answer get", async () => {
    const redis = new RedisMock();
    const failure = new Error("redis get failed");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      get: [rejectWith(failure)],
    });
    const inner = createMockFacilitator();
    const recording = createRecordingFacilitator(inner);
    const gate = createPaywall(config, {
      signer,
      facilitator: recording.client,
      cache: createRedisSettlementCache({ client }),
    });

    await expect(gate({ ...baseRequest, headers })).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
  });

  it("fails closed with no settlement when the lock cannot be acquired", async () => {
    const redis = new RedisMock();
    const failure = new Error("redis set failed");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      set: [rejectWith(failure)],
    });
    const inner = createMockFacilitator();
    const recording = createRecordingFacilitator(inner);
    const gate = createPaywall(config, {
      signer,
      facilitator: recording.client,
      cache: createRedisSettlementCache({ client }),
    });

    await expect(gate({ ...baseRequest, headers })).rejects.toBe(failure);
    expect(recording.settleCalls.size).toBe(0);
  });

  it("returns the receipt and reports a failed cache write after settlement", async () => {
    const redis = new RedisMock();
    const writeFailure = new Error("redis write failed");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      set: [pass(), rejectWith(writeFailure)],
    });
    const reported: Error[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createRedisSettlementCache({ client }),
      onCacheError: (error) => reported.push(error),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") expect(outcome.cacheError).toBe(writeFailure);
    expect(reported).toEqual([writeFailure]);
  });

  it("reports a failed lock release after settlement", async () => {
    const redis = new RedisMock();
    const releaseFailure = new Error("redis eval failed");
    const client = scriptedRedis(redis as unknown as RedisLikeClient, {
      eval: [rejectWith(releaseFailure)],
    });
    const reported: Error[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: createRedisSettlementCache({ client }),
      onCacheError: (error) => reported.push(error),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") expect(outcome.cacheError).toBe(releaseFailure);
    expect(reported).toEqual([releaseFailure]);
  });

  // A lock nobody renews and nobody releases must free itself, so a dead
  // process costs at most one lock TTL of duplicate protection.
  it("frees a lock once its TTL passes", async () => {
    vi.useFakeTimers();
    try {
      const redis = new RedisMock();
      const keyPrefix = "failure:lock-ttl:";
      const client = scriptedRedis(redis as unknown as RedisLikeClient);
      const cache = createRedisSettlementCache({ client, keyPrefix });
      const lock = await cache.acquire("x402:nonce", 100);
      expect(lock).not.toBe(false);
      if (!lock) return;

      await vi.advanceTimersByTimeAsync(200);
      // The holder's release after the TTL no longer owns the lock.
      expect(await cache.release?.("x402:nonce", lock)).toBe(false);
      expect(await locksLeft(redis, keyPrefix)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lock lost when renewal fails mid-settlement", async () => {
    vi.useFakeTimers();
    try {
      const redis = new RedisMock();
      const keyPrefix = "failure:renew-fails:";
      const renewFailure = new Error("redis flap");
      const client = scriptedRedis(redis as unknown as RedisLikeClient, {
        eval: [rejectWith(renewFailure), pass()],
      });
      const inner = createMockFacilitator();
      const recording = createRecordingFacilitator(inner);
      const facilitator: FacilitatorClient = {
        ...recording.client,
        async settle(input) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return inner.settle(input);
        },
      };
      const reported: Error[] = [];
      const gate = createPaywall(config, {
        signer,
        facilitator,
        cache: createRedisSettlementCache({ client, keyPrefix }),
        settlementLockTtlMs: 90,
        onCacheError: (error) => reported.push(error),
      });

      const pending = gate({ ...baseRequest, headers });
      await vi.advanceTimersByTimeAsync(60);
      const outcome = await pending;

      expect(outcome.kind).toBe("settled");
      if (outcome.kind === "settled") {
        expect(outcome.lockLost).toBe(true);
        expect(outcome.cacheError).toBe(renewFailure);
      }
      expect(reported).toContain(renewFailure);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("two gate processes sharing one Redis", () => {
  it("settles once when one process is waiting on a hung /settle", async () => {
    vi.useFakeTimers();
    const redis = new RedisMock();
    const keyPrefix = "failure:multi-process:";
    const recording = createRecordingFacilitator(
      scriptedFacilitator(createMockFacilitator(), { settle: [hang()] }),
    );
    const facilitator = recording.client;
    const inFlightA = newInFlight();
    const inFlightB = newInFlight();
    const shared = { signer, facilitator, facilitatorTimeoutMs: 1_000 };
    const processA = createPaywallWithInFlight(
      config,
      {
        ...shared,
        cache: createRedisSettlementCache({
          client: redis as unknown as RedisLikeClient,
          keyPrefix,
        }),
      },
      inFlightA,
    );
    const processB = createPaywallWithInFlight(
      config,
      {
        ...shared,
        cache: createRedisSettlementCache({
          client: redis as unknown as RedisLikeClient,
          keyPrefix,
        }),
      },
      inFlightB,
    );
    const harness = invariantHarness(inFlightA);

    const first = processA({ ...baseRequest, headers }).then((outcome) => harness.record(outcome));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toMatchObject({ kind: "rejected", status: 503 });

    const second = await processB({ ...baseRequest, headers });
    expect(second).toMatchObject({ kind: "rejected", status: 409 });
    expect(recording.settleCalls.size).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await harness.check(recording.settleCalls, await locksLeft(redis, keyPrefix));
  });
});
