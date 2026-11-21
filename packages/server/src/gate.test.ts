import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaywall, type PaywallConfig, type TollwayRequest } from "./gate.js";
import {
  decodeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "./headers.js";
import { createMockMppChargeHandler, type MppChargeHandler } from "./mpp-charge.js";

const MPP_CREDENTIAL = "Payment mock-mpp-charge-payload";

const config: PaywallConfig = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
};

const baseRequest: TollwayRequest = {
  method: "GET",
  url: "/quotes/latest",
  headers: {},
};

/** A standard-base64 x402 V2 payment header, as a stock client writes it. */
function paymentHeader(transaction = "mock-signed-auth-entry"): string {
  return encodePaymentSignatureHeader({
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
  });
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
});

function makeGate(mppCharge = false) {
  return createPaywall(
    { ...config, models: mppCharge ? ["mpp-charge"] : ["x402"] },
    {
      signer,
      facilitator: createMockFacilitator(),
      mppChargeHandler: mppCharge ? createMockMppChargeHandler() : undefined,
      cache: createInMemorySettlementCache(),
    },
  );
}

describe("createPaywall", () => {
  it("answers 402 with an x402 V2 challenge when no payment is present", async () => {
    const outcome = await makeGate()(baseRequest);
    expect(outcome.kind).toBe("payment-required");
    if (outcome.kind !== "payment-required") return;

    expect(outcome.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "");
    expect(decoded).toEqual(outcome.challenge);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("/quotes/latest");
    expect(decoded.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: "stellar:testnet",
        asset: config.asset,
        amount: "10000",
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      }),
    ]);
  });

  it("sends the x402 challenge terms the paywall config declares", async () => {
    const gate = createPaywall(
      { ...config, maxTimeoutSeconds: 30, extra: { areFeesSponsored: true } },
      { signer, facilitator: createMockFacilitator() },
    );
    const outcome = await gate(baseRequest);
    if (outcome.kind !== "payment-required") throw new Error("expected a challenge");
    expect(
      decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "").accepts[0],
    ).toMatchObject({ maxTimeoutSeconds: 30, extra: { areFeesSponsored: true } });
  });

  it("rejects a malformed PAYMENT-SIGNATURE with 400", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "%%%not-base64%%%" },
    });
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toMatch(/not a base64 x402 PaymentPayload/);
  });

  it("rejects a base64url PAYMENT-SIGNATURE with 400", async () => {
    // U+0080 U+00BE encode to bytes that standard base64 spells with `+`, so
    // the base64url form contains `-` and cannot pass @x402/core's
    // standard-alphabet check.
    const standard = encodePaymentSignatureHeader({
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
      payload: { transaction: "mock-signed-auth-entry" },
      extensions: { probe: "\u0080\u00be" },
    });
    const base64url = Buffer.from(standard, "base64").toString("base64url");
    expect(base64url).not.toBe(standard);
    expect(() => decodePaymentSignatureHeader(base64url)).toThrow();
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: base64url },
    });
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
  });

  it("rejects a payment whose x402Version is not 2 with 400", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 1,
          accepted: {
            scheme: "exact",
            network: "stellar:testnet",
            asset: config.asset,
            amount: config.amount,
            payTo: config.payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: { transaction: "mock-signed-auth-entry" },
        }),
      },
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      status: 400,
      reason: expect.stringContaining("unsupported x402Version 1"),
    });
  });

  it("sends the x402 SettleResponse and the Tollway receipt on settlement", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
    });
    if (outcome.kind !== "settled") throw new Error("expected a settlement");

    const settlement = decodePaymentResponseHeader(outcome.headers[PAYMENT_RESPONSE_HEADER] ?? "");
    expect(settlement).toMatchObject({ success: true, network: "stellar:testnet" });
    const { settlement: settled } = outcome.receipt.receipt;
    if (settled.kind !== "transaction") throw new Error("expected a transaction settlement");
    expect(settlement.transaction).toBe(settled.txHash);
    expect(decodeHeader(outcome.headers[TOLLWAY_RECEIPT_HEADER] ?? "")).toEqual(outcome.receipt);
  });

  it("settles a signed request and produces a verifiable receipt", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;

    expect(outcome.replayed).toBe(false);
    expect(outcome.receipt.receipt.model).toBe("x402");
    expect(outcome.receipt.receipt.amount).toBe("10000");
    expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

    const verifier = Ed25519Verifier.forSigner(signer);
    expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({
      valid: true,
      receipt: outcome.receipt,
    });
  });

  it("treats a repeated payment as idempotent rather than a second charge", async () => {
    const gate = makeGate();
    const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

    const first = await gate({ ...baseRequest, headers });
    const second = await gate({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.receipt.receipt.id).toBe(first.receipt.receipt.id);
  });

  it("treats an empty signature header as no payment at all", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "" },
    });
    expect(outcome.kind).toBe("payment-required");
  });

  describe("with mpp-charge model", () => {
    it("settles a signed request and produces a verifiable receipt", async () => {
      const outcome = await makeGate(true)({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;

      expect(outcome.replayed).toBe(false);
      expect(outcome.receipt.receipt.model).toBe("mpp-charge");
      expect(outcome.receipt.receipt.amount).toBe("10000");
      expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

      const verifier = Ed25519Verifier.forSigner(signer);
      expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({
        valid: true,
        receipt: outcome.receipt,
      });
    });

    it("treats a repeated mpp-charge payment as idempotent rather than a second charge", async () => {
      const gate = makeGate(true);
      const headers = { authorization: MPP_CREDENTIAL };

      const first = await gate({ ...baseRequest, headers });
      const second = await gate({ ...baseRequest, headers });
      expect(first.kind).toBe("settled");
      expect(second.kind).toBe("settled");
      if (first.kind !== "settled" || second.kind !== "settled") return;

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.receipt.receipt.id).toBe(first.receipt.receipt.id);
    });

    it("rejects when mpp-charge handler is not configured", async () => {
      const gate = createPaywall(
        { ...config, models: ["mpp-charge"] },
        {
          signer,
          facilitator: createMockFacilitator(),
          cache: createInMemorySettlementCache(),
        },
      );
      const outcome = await gate({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") return;
      expect(outcome.status).toBe(500);
      expect(outcome.reason).toBe("mpp-charge handler not configured");
    });

    it("passes only the Payment scheme of the Authorization header to the handler", async () => {
      const handler = createMockMppChargeHandler();
      const verify = vi.spyOn(handler, "verify");
      const gate = createPaywall(
        { ...config, models: ["mpp-charge"] },
        { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
      );
      await gate({ ...baseRequest, headers: { Authorization: `Bearer abc, ${MPP_CREDENTIAL}` } });
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ payment: { model: "mpp-charge", payload: MPP_CREDENTIAL } }),
      );
    });

    it("adds the handler's MPP challenge headers to the 402", async () => {
      const handler: MppChargeHandler = {
        ...createMockMppChargeHandler(),
        challenge: vi.fn().mockResolvedValue({
          status: 402,
          headers: {
            "www-authenticate": 'Payment id="abc"',
            "cache-control": "no-store",
            "content-type": "application/problem+json",
          },
          body: '{"title":"Payment Required"}',
        }),
      };
      const gate = createPaywall(
        { ...config, models: ["x402", "mpp-charge"] },
        { signer, facilitator: createMockFacilitator(), mppChargeHandler: handler },
      );
      const outcome = await gate(baseRequest);
      expect(outcome.kind).toBe("payment-required");
      if (outcome.kind !== "payment-required") return;
      expect(outcome.headers["www-authenticate"]).toBe('Payment id="abc"');
      expect(outcome.headers["cache-control"]).toBe("no-store");
      // The adapters send the offer as JSON, so mppx's body headers are dropped.
      expect(outcome.headers["content-type"]).toBeUndefined();
      expect(outcome.headers[PAYMENT_REQUIRED_HEADER]).toBeDefined();
      expect(handler.challenge).toHaveBeenCalledWith({
        offer: expect.objectContaining({
          resource: "/quotes/latest",
          amount: "10000",
          asset: config.asset,
        }),
        request: { method: "GET", url: "/quotes/latest" },
      });
    });

    it("does not ask for an MPP challenge on a route that does not accept mpp-charge", async () => {
      const challenge = vi.fn();
      const gate = createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        mppChargeHandler: { ...createMockMppChargeHandler(), challenge },
      });
      const outcome = await gate(baseRequest);
      expect(outcome.kind).toBe("payment-required");
      expect(challenge).not.toHaveBeenCalled();
    });

    it("ignores an MPP credential on a route that only accepts x402", async () => {
      const outcome = await makeGate(false)({
        ...baseRequest,
        headers: { authorization: MPP_CREDENTIAL },
      });
      expect(outcome.kind).toBe("payment-required");
    });

    it("rejects a PAYMENT-SIGNATURE that the router sends to mpp-charge", async () => {
      const outcome = await makeGate(true)({
        ...baseRequest,
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() },
      });
      expect(outcome).toEqual({
        kind: "rejected",
        status: 400,
        reason:
          "mpp-charge payments carry an Authorization: Payment credential, not PAYMENT-SIGNATURE",
      });
    });
  });
});

describe("TM-02 cross-offer replay", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

  function gateFor(overrides: Partial<PaywallConfig>, cache: SettlementCache) {
    return createPaywall(
      { ...config, ...overrides },
      {
        signer,
        facilitator: createMockFacilitator(),
        mppChargeHandler: createMockMppChargeHandler(),
        cache,
      },
    );
  }

  it("rejects a payment settled for one resource when replayed on another", async () => {
    const cache = createInMemorySettlementCache();
    const first = await gateFor({ resource: "/a" }, cache)({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");

    const replay = await gateFor({ resource: "/b" }, cache)({ ...baseRequest, headers });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });

  it("rejects a replay on an offer with a different amount", async () => {
    const cache = createInMemorySettlementCache();
    const first = await gateFor({ resource: "/a" }, cache)({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");

    const replay = await gateFor(
      { resource: "/a", amount: "99999999" },
      cache,
    )({
      ...baseRequest,
      headers,
    });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
  });

  it("does not serve an x402 receipt to an mpp-charge offer that shares the cache", async () => {
    const cache = createInMemorySettlementCache();
    const x402 = await gateFor(
      { models: ["x402"] },
      cache,
    )({ ...baseRequest, headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() } });
    expect(x402.kind).toBe("settled");

    const mpp = await gateFor(
      { models: ["mpp-charge"] },
      cache,
    )({ ...baseRequest, headers: { authorization: MPP_CREDENTIAL } });
    expect(mpp.kind).toBe("settled");
    if (mpp.kind !== "settled") return;
    expect(mpp.replayed).toBe(false);
    expect(mpp.receipt.receipt.model).toBe("mpp-charge");
  });

  describe("TM-03 same-process concurrent duplicate", () => {
    it("settles concurrent identical payments once", async () => {
      const inner = createMockFacilitator();
      let settleCalls = 0;
      const slowFacilitator: FacilitatorClient = {
        ...inner,
        async settle(input) {
          settleCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return inner.settle(input);
        },
      };
      const gate = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createInMemorySettlementCache(),
      });

      const [first, second] = await Promise.all([
        gate({ ...baseRequest, headers }),
        gate({ ...baseRequest, headers }),
      ]);

      expect(settleCalls).toBe(1);
      expect(first.kind).toBe("settled");
      expect(second.kind).toBe("settled");
      if (first.kind !== "settled" || second.kind !== "settled") return;
      expect(second.receipt).toEqual(first.receipt);
    });
  });

  it("does not leave a cache write rejection unhandled", async () => {
    const writeError = new Error("redis down");
    const failingCache: SettlementCache = {
      async get() {
        return undefined;
      },
      async set() {
        throw writeError;
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = await createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        cache: failingCache,
      })({ ...baseRequest, headers });
      // Give a floating rejection time to surface before checking.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.cacheError).toBe(writeError);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("TM-04 shared-lock duplicate settlement", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader() };

  function countingFacilitator() {
    const inner = createMockFacilitator();
    const calls = { settle: 0 };
    const facilitator: FacilitatorClient = {
      ...inner,
      async settle(input) {
        calls.settle++;
        return inner.settle(input);
      },
    };
    return { facilitator, calls };
  }

  // ioredis-mock instances share one store, so each test uses its own prefix.
  it("answers 409 and does not settle while another process holds the lock", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:held-lock:";
    const { facilitator, calls } = countingFacilitator();
    const gate = createPaywall(config, {
      signer,
      facilitator,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });

    // The mock facilitator's nonce for this header, as the gate keys it.
    const verification = await facilitator.verify({
      payment: {
        model: "x402",
        payload: decodePaymentSignatureHeader(headers[PAYMENT_SIGNATURE_HEADER]),
      },
      offer: { ...config, resource: baseRequest.url, models: ["x402"] },
    });
    if (!verification.valid) throw new Error("expected the mock to accept the payment");
    const otherProcess = createRedisSettlementCache({ client, keyPrefix });
    await expect(otherProcess.acquire(`x402:${verification.nonce}`, 30_000)).resolves.toEqual({
      token: expect.any(String),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome).toEqual({ kind: "rejected", status: 409, reason: "settlement in progress" });
    expect(calls.settle).toBe(0);
  });

  // Regression lock for ADR-2026-11-18-redis-lock-ownership: a /settle that
  // outlives the lock TTL must not let a second process settle the same payment.
  // Fake timers drive both the renewal interval and Redis expiry (ioredis-mock
  // reads Date.now), so the outcome does not depend on how busy the machine is.
  it("keeps the lock alive while a slow settlement runs", async () => {
    vi.useFakeTimers();
    try {
      const client = new RedisMock() as unknown as RedisLikeClient;
      const keyPrefix = "gate-test:slow-settle:";
      const inner = createMockFacilitator();
      const calls = { settle: 0 };
      const slowFacilitator: FacilitatorClient = {
        ...inner,
        async settle(input) {
          calls.settle++;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return inner.settle(input);
        },
      };
      const lockTtl = { settlementLockTtlMs: 900 };
      const processA = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createRedisSettlementCache({ client, keyPrefix }),
        ...lockTtl,
      });
      const processB = createPaywall(config, {
        signer,
        facilitator: slowFacilitator,
        cache: createRedisSettlementCache({ client, keyPrefix }),
        ...lockTtl,
      });

      const first = processA({ ...baseRequest, headers });
      // A retry of the same payment reaches another process long after the
      // original TTL would have expired without renewal.
      await vi.advanceTimersByTimeAsync(1_800);
      const second = await processB({ ...baseRequest, headers });
      expect(second).toEqual({ kind: "rejected", status: 409, reason: "settlement in progress" });

      await vi.advanceTimersByTimeAsync(1_500);
      expect((await first).kind).toBe("settled");
      expect(calls.settle).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lock lost during settlement instead of hiding it", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:lost-lock:";
    const inner = createMockFacilitator();
    const reported: string[] = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...inner,
        async settle(input) {
          // The lock disappears mid-settlement (Redis failover, eviction).
          await redis.del(`${keyPrefix}lock:x402:${input.nonce}`);
          await new Promise((resolve) => setTimeout(resolve, 120));
          return inner.settle(input);
        },
      },
      cache: createRedisSettlementCache({ client, keyPrefix }),
      settlementLockTtlMs: 90,
      onCacheError: (error) => reported.push(error.message),
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.lockLost).toBe(true);
    expect(outcome.cacheError).toBeInstanceOf(Error);
    expect(reported).toHaveLength(1);
  });

  it("refuses a cache that implements only part of the lock interface", () => {
    const partial = {
      ...createInMemorySettlementCache(),
      async acquire() {
        return { token: "t" };
      },
    };
    expect(() =>
      createPaywall(config, { signer, facilitator: createMockFacilitator(), cache: partial }),
    ).toThrow(/acquire, renew and release/);
  });

  it("releases the lock after settling so a retry replays the receipt", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const { facilitator, calls } = countingFacilitator();
    const cache = createRedisSettlementCache({ client, keyPrefix: "gate-test:release:" });
    const gate = createPaywall(config, { signer, facilitator, cache });

    const first = await gate({ ...baseRequest, headers });
    const second = await gate({ ...baseRequest, headers });
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;
    expect(second.replayed).toBe(true);
    expect(second.receipt).toEqual(first.receipt);
    expect(calls.settle).toBe(1);
  });

  it("reports a cache write failure to onCacheError with the cache key", async () => {
    const writeError = new Error("redis down");
    const reported: Array<{ error: Error; key: string }> = [];
    const gate = createPaywall(config, {
      signer,
      facilitator: createMockFacilitator(),
      cache: {
        async get() {
          return undefined;
        },
        async set() {
          throw writeError;
        },
      },
      onCacheError: (error, key) => {
        reported.push({ error, key });
      },
    });

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome.kind).toBe("settled");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(writeError);
    expect(reported[0]?.key).toMatch(/^x402:/);
  });
});

// Regression lock for ADR-2026-11-18-method-binding: one payment pays for one
// HTTP method, even when a single gate is mounted on several methods.
describe("method binding", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: paymentHeader("mock-signed-auth-entry-method") };

  function countingGate(cache = createInMemorySettlementCache()) {
    const inner = createMockFacilitator();
    const calls = { settle: 0 };
    const gate = createPaywall(config, {
      signer,
      facilitator: {
        ...inner,
        async settle(input) {
          calls.settle++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return inner.settle(input);
        },
      },
      cache,
    });
    return { gate, calls };
  }

  it("does not serve a payment made for GET to a POST on the same URL", async () => {
    const { gate, calls } = countingGate();
    const read = await gate({ ...baseRequest, method: "GET", headers });
    expect(read.kind).toBe("settled");

    const write = await gate({ ...baseRequest, method: "POST", headers });
    expect(write).toEqual({
      kind: "rejected",
      status: 409,
      reason: "payment already settled for a different offer",
    });
    expect(calls.settle).toBe(1);
  });

  it("still replays a retry of the same method", async () => {
    const { gate, calls } = countingGate();
    await gate({ ...baseRequest, method: "GET", headers });
    const retry = await gate({ ...baseRequest, method: "get", headers });
    expect(retry.kind).toBe("settled");
    if (retry.kind === "settled") expect(retry.replayed).toBe(true);
    expect(calls.settle).toBe(1);
  });

  it("settles once and rejects the other method when both arrive together", async () => {
    const { gate, calls } = countingGate();
    const [read, write] = await Promise.all([
      gate({ ...baseRequest, method: "GET", headers }),
      gate({ ...baseRequest, method: "POST", headers }),
    ]);
    expect(read.kind).toBe("settled");
    expect(write).toMatchObject({ kind: "rejected", status: 409 });
    expect(calls.settle).toBe(1);
  });

  it("refuses a Redis entry written without a method, without settling again", async () => {
    const redis = new RedisMock();
    const client = redis as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:legacy-entry:";
    const { gate: writer } = countingGate(createRedisSettlementCache({ client, keyPrefix }));
    const settled = await writer({ ...baseRequest, method: "GET", headers });
    if (settled.kind !== "settled") throw new Error("expected the first request to settle");

    // An older process stored the bare receipt, with no method.
    const keys = await redis.keys(`${keyPrefix}x402:*`);
    expect(keys).toHaveLength(1);
    await redis.set(keys[0] as string, JSON.stringify(settled.receipt), "EX", 30);

    const { gate, calls } = countingGate(createRedisSettlementCache({ client, keyPrefix }));
    const outcome = await gate({ ...baseRequest, method: "GET", headers });
    expect(outcome).toMatchObject({ kind: "rejected", status: 409 });
    expect(calls.settle).toBe(0);
  });
});
