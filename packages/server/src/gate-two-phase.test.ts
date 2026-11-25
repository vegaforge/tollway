/**
 * Two-phase settlement (#152): `gate.authorize` verifies and locks a
 * payment, the route handler runs, and only then does `settle()` reach the
 * facilitator, or `abandon()` let the payment go unsettled.
 */

import { Ed25519Signer } from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  type AuthorizeOutcome,
  createPaywall,
  type PaymentObserver,
  type PaymentObserverEvent,
  type PaymentObserverMetric,
  type PaywallConfig,
  type PaywallDeps,
  type TollwayRequest,
  type TwoPhaseConfig,
} from "./gate.js";
import {
  encodePaymentSignatureHeader,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { createMockMppChargeHandler, type MppChargeHandler } from "./mpp-charge.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

function paid(transaction = "mock-signed-auth-entry", maxTimeoutSeconds = 60): TollwayRequest {
  return {
    method: "GET",
    url: "/quotes/latest",
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "stellar:testnet",
          asset: config.asset,
          amount: config.amount,
          payTo: config.payTo,
          maxTimeoutSeconds,
          extra: {},
        },
        payload: { transaction },
      }),
    },
  };
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
});

afterEach(() => {
  vi.useRealTimers();
});

/** The mock facilitator, counting settle calls, optionally refusing them. */
function facilitator(settleResult?: { settled: false; reason: string }) {
  const inner = createMockFacilitator();
  const calls = { settle: 0 };
  const client: FacilitatorClient = {
    ...inner,
    async settle(input) {
      calls.settle += 1;
      return settleResult ?? inner.settle(input);
    },
  };
  return { client, calls };
}

function makeGate(
  options: {
    config?: { maxTimeoutSeconds?: number; twoPhase?: TwoPhaseConfig };
    deps?: Partial<PaywallDeps>;
    settleResult?: { settled: false; reason: string };
  } = {},
) {
  const { client, calls } = facilitator(options.settleResult);
  const gate = createPaywall(
    { ...config, ...options.config },
    {
      signer,
      facilitator: client,
      cache: createInMemorySettlementCache(),
      ...options.deps,
    },
  );
  return { gate, calls };
}

function authorized(outcome: AuthorizeOutcome) {
  if (outcome.kind !== "authorized") {
    throw new Error(`expected authorized, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("gate.authorize", () => {
  it("answers 402 without a payment, like the single-shot gate", async () => {
    const { gate } = makeGate();

    const outcome = await gate.authorize({ ...paid(), headers: {} });

    expect(outcome.kind).toBe("payment-required");
  });

  it("rejects an invalid payment without authorizing it", async () => {
    const { gate, calls } = makeGate();

    const outcome = await gate.authorize(paid(""));

    expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
    expect(calls.settle).toBe(0);
  });

  it("verifies but does not settle until settle() is called", async () => {
    const { gate, calls } = makeGate();

    const authorization = authorized(await gate.authorize(paid()));
    expect(calls.settle).toBe(0);

    const outcome = await authorization.settle();

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.headers[PAYMENT_RESPONSE_HEADER]).toBeDefined();
    expect(outcome.replayed).toBe(false);
    expect(calls.settle).toBe(1);
  });

  it("never settles an abandoned payment, and frees it for a retry", async () => {
    const { gate, calls } = makeGate();

    await authorized(await gate.authorize(paid())).abandon("handler-failed");
    expect(calls.settle).toBe(0);

    // Nothing settled and the slot is free, so the same payment authorizes again.
    const retry = authorized(await gate.authorize(paid()));
    await retry.settle();
    expect(calls.settle).toBe(1);
  });

  it("makes abandon() idempotent", async () => {
    const { gate, calls } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));

    await authorization.abandon("handler-threw");
    await authorization.abandon("handler-threw");

    expect(calls.settle).toBe(0);
  });

  it("refuses a second settle() for one authorization", async () => {
    const { gate, calls } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));

    await authorization.settle();

    await expect(authorization.settle()).rejects.toThrow(TypeError);
    expect(calls.settle).toBe(1);
  });

  it("refuses settle() after abandon()", async () => {
    const { gate, calls } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));

    await authorization.abandon("handler-failed");

    await expect(authorization.settle()).rejects.toThrow(TypeError);
    expect(calls.settle).toBe(0);
  });

  it("ignores abandon() after settle(): a settlement cannot be undone", async () => {
    const { gate, calls } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));
    const settled = await authorization.settle();

    await authorization.abandon("handler-failed");

    // The receipt stays cached: the same payment replays instead of settling.
    const replay = await gate.authorize(paid());
    expect(replay).toMatchObject({ kind: "settled", replayed: true });
    if (replay.kind !== "settled" || settled.kind !== "settled") return;
    expect(replay.receipt).toEqual(settled.receipt);
    expect(calls.settle).toBe(1);
  });

  it("returns the settlement rejection when /settle refuses after a successful handler", async () => {
    const { gate, calls } = makeGate({ settleResult: { settled: false, reason: "tx failed" } });

    const outcome = await authorized(await gate.authorize(paid())).settle();

    expect(outcome).toMatchObject({
      kind: "rejected",
      status: 502,
      code: "settlement-failed",
      upstreamReason: "tx failed",
    });
    expect(calls.settle).toBe(1);
  });

  it("answers a replay of a settled payment with its receipt, without a second phase", async () => {
    const { gate, calls } = makeGate();
    await authorized(await gate.authorize(paid())).settle();

    const replay = await gate.authorize(paid());

    expect(replay).toMatchObject({ kind: "settled", replayed: true });
    expect(calls.settle).toBe(1);
  });

  it("holds a concurrent duplicate until the first handler finishes, then replays", async () => {
    const { gate, calls } = makeGate();
    const first = authorized(await gate.authorize(paid()));

    let duplicateDone = false;
    const duplicate = gate.authorize(paid()).then((outcome) => {
      duplicateDone = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The handler is still running: the duplicate neither settles nor runs.
    expect(duplicateDone).toBe(false);

    await first.settle();

    expect(await duplicate).toMatchObject({ kind: "settled", replayed: true });
    expect(calls.settle).toBe(1);
  });

  it("tells a concurrent duplicate to retry when the first handler failed", async () => {
    const { gate, calls } = makeGate();
    const first = authorized(await gate.authorize(paid()));
    const duplicate = gate.authorize(paid());

    await first.abandon("handler-failed");

    expect(await duplicate).toMatchObject({
      kind: "rejected",
      status: 503,
      code: "payment-not-settled",
      headers: { "retry-after": "1" },
    });
    expect(calls.settle).toBe(0);
  });

  it("abandons a handler that outlives the payment's validity window", async () => {
    vi.useFakeTimers();
    const { gate, calls } = makeGate({ config: { maxTimeoutSeconds: 5 } });
    const authorization = authorized(await gate.authorize(paid("mock-signed-auth-entry", 5)));

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await authorization.settle();

    expect(outcome).toMatchObject({ kind: "rejected", status: 504, code: "handler-timeout" });
    expect(calls.settle).toBe(0);
  });

  it("settles a handler that finishes inside the validity window", async () => {
    vi.useFakeTimers();
    const { gate, calls } = makeGate({ config: { maxTimeoutSeconds: 5 } });
    const authorization = authorized(await gate.authorize(paid("mock-signed-auth-entry", 5)));

    await vi.advanceTimersByTimeAsync(4_999);
    const outcome = await authorization.settle();

    expect(outcome.kind).toBe("settled");
    expect(calls.settle).toBe(1);
  });

  it("treats every 5xx as a handler failure by default", async () => {
    const { gate } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));

    expect([500, 503, 599].map((status) => authorization.isFailure(status))).toEqual([
      true,
      true,
      true,
    ]);
    expect([200, 204, 404, 499].map((status) => authorization.isFailure(status))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    await authorization.abandon("handler-failed");
  });

  it("uses the configured failure statuses and response limit", async () => {
    const { gate } = makeGate({
      config: {
        twoPhase: { isFailureStatus: (status) => status >= 400, maxResponseBytes: 2048 },
      },
    });
    const authorization = authorized(await gate.authorize(paid()));

    expect(authorization.isFailure(404)).toBe(true);
    expect(authorization.maxResponseBytes).toBe(2048);
    await authorization.abandon("handler-failed");
  });

  it("holds responses up to 1 MiB by default", async () => {
    const { gate } = makeGate();
    const authorization = authorized(await gate.authorize(paid()));

    expect(authorization.maxResponseBytes).toBe(1_048_576);
    await authorization.abandon("handler-failed");
  });

  it("refuses an invalid response limit at construction", () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => makeGate({ config: { twoPhase: { maxResponseBytes } } })).toThrow(TypeError);
    }
  });

  it("leaves the single-shot gate settling before it returns", async () => {
    const { gate, calls } = makeGate();

    const outcome = await gate(paid());

    expect(outcome.kind).toBe("settled");
    expect(calls.settle).toBe(1);
  });
});

describe("gate.authorize and the payment observer (#106)", () => {
  function observed() {
    const metrics: PaymentObserverMetric[] = [];
    const events: PaymentObserverEvent[] = [];
    const observer: PaymentObserver = {
      record: (metric) => {
        metrics.push(metric);
      },
      emit: async (event) => {
        events.push(event);
      },
    };
    return { observer, metrics, events };
  }

  it("records a settled payment and emits its receipt once settle() succeeds", async () => {
    const { observer, metrics, events } = observed();
    const { gate } = makeGate({ deps: { observer } });

    const authorization = authorized(await gate.authorize(paid()));
    expect(metrics).toEqual([]);
    await authorization.settle();

    expect(metrics.map((metric) => metric.outcome)).toEqual(["settled"]);
    expect(events.map((event) => event.type)).toEqual(["receipt.created"]);
  });

  it("records an abandoned payment as failed and emits no receipt", async () => {
    const { observer, metrics, events } = observed();
    const { gate } = makeGate({ deps: { observer } });

    await authorized(await gate.authorize(paid())).abandon("handler-failed");

    expect(metrics.map((metric) => metric.outcome)).toEqual(["failed"]);
    expect(events).toEqual([]);
  });
});

describe("gate.authorize with mpp-charge", () => {
  it("holds an MPP charge until settle(), and never settles an abandoned one", async () => {
    const inner = createMockMppChargeHandler();
    const calls = { settle: 0 };
    const mppChargeHandler: MppChargeHandler = {
      ...inner,
      async settle(input) {
        calls.settle += 1;
        return inner.settle(input);
      },
    };
    const gate = createPaywall(
      { ...config, models: ["mpp-charge"] },
      { signer, facilitator: createMockFacilitator(), mppChargeHandler },
    );
    const request: TollwayRequest = {
      method: "GET",
      url: "/quotes/latest",
      headers: { authorization: "Payment mock-mpp-charge-payload" },
    };

    await authorized(await gate.authorize(request)).abandon("handler-threw");
    expect(calls.settle).toBe(0);

    const outcome = await authorized(await gate.authorize(request)).settle();
    expect(outcome.kind).toBe("settled");
    expect(calls.settle).toBe(1);
  });
});

describe("gate.authorize across processes", () => {
  // ioredis-mock instances share one store, so each test uses its own prefix.
  it("holds the settlement lock across the handler, so another process cannot settle", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const keyPrefix = "two-phase:held:";
    const { client: facilitatorClient, calls } = facilitator();
    const deps = { signer, facilitator: facilitatorClient };
    const processA = createPaywall(config, {
      ...deps,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });
    const processB = createPaywall(config, {
      ...deps,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });

    const authorization = authorized(await processA.authorize(paid()));
    expect(await processB.authorize(paid())).toMatchObject({ kind: "rejected", status: 409 });

    await authorization.settle();
    expect(await processB.authorize(paid())).toMatchObject({ kind: "settled", replayed: true });
    expect(calls.settle).toBe(1);
  });

  it("abandons with a typed rejection when the lock is lost while the handler runs", async () => {
    const inner = createInMemorySettlementCache();
    const tokens = new Map<string, string>();
    // A lock store whose renewals all report the lock gone, as after an
    // expiry another process took over.
    const cache: SettlementCache = {
      ...inner,
      async acquire(key) {
        const token = crypto.randomUUID();
        tokens.set(key, token);
        return { token };
      },
      async renew() {
        return false;
      },
      async release(key, lock) {
        return tokens.get(key) === lock.token;
      },
    };
    const { client, calls } = facilitator();
    const gate = createPaywall(config, {
      signer,
      facilitator: client,
      cache,
      settlementLockTtlMs: 30,
    });

    const authorization = authorized(await gate.authorize(paid()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const outcome = await authorization.settle();

    expect(outcome).toMatchObject({ kind: "rejected", status: 503, code: "payment-not-settled" });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toMatch(/^lock-lost: /);
    expect(calls.settle).toBe(0);
  });
});
