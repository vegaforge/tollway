import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@tollway/core";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaywall, type PaywallConfig, type TollwayRequest } from "./gate.js";
import { decodeHeader, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./headers.js";
import { createMockMppChargeHandler } from "./mpp-charge.js";

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
  it("answers 402 with an encoded challenge when no payment is present", async () => {
    const outcome = await makeGate()(baseRequest);
    expect(outcome.kind).toBe("payment-required");
    if (outcome.kind !== "payment-required") return;

    expect(outcome.status).toBe(402);
    const decoded = decodeHeader<{ amount: string; resource: string }>(
      outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "",
    );
    expect(decoded.amount).toBe("10000");
    expect(decoded.resource).toBe("/quotes/latest");
  });

  it("settles a signed request and produces a verifiable receipt", async () => {
    const outcome = await makeGate()({
      ...baseRequest,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" },
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;

    expect(outcome.replayed).toBe(false);
    expect(outcome.receipt.receipt.model).toBe("x402");
    expect(outcome.receipt.receipt.amount).toBe("10000");
    expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

    const verifier = Ed25519Verifier.forSigner(signer);
    expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({ valid: true });
  });

  it("treats a repeated payment as idempotent rather than a second charge", async () => {
    const gate = makeGate();
    const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" };

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
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-mpp-charge-payload" },
      });
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;

      expect(outcome.replayed).toBe(false);
      expect(outcome.receipt.receipt.model).toBe("mpp-charge");
      expect(outcome.receipt.receipt.amount).toBe("10000");
      expect(outcome.receipt.receipt.settlement.kind).toBe("transaction");

      const verifier = Ed25519Verifier.forSigner(signer);
      expect(await verifyReceipt(outcome.receipt, verifier)).toEqual({ valid: true });
    });

    it("treats a repeated mpp-charge payment as idempotent rather than a second charge", async () => {
      const gate = makeGate(true);
      const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-mpp-charge-payload" };

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
        headers: { [PAYMENT_SIGNATURE_HEADER]: "mock-mpp-charge-payload" },
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") return;
      expect(outcome.status).toBe(500);
      expect(outcome.reason).toBe("mpp-charge handler not configured");
    });
  });
});

describe("settlement cache binding", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" };

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
    // Both mock handlers derive the nonce from the raw header, so the same
    // header value gives the same nonce under either model.
    const cache = createInMemorySettlementCache();
    const x402 = await gateFor({ models: ["x402"] }, cache)({ ...baseRequest, headers });
    expect(x402.kind).toBe("settled");

    const mpp = await gateFor({ models: ["mpp-charge"] }, cache)({ ...baseRequest, headers });
    expect(mpp.kind).toBe("settled");
    if (mpp.kind !== "settled") return;
    expect(mpp.replayed).toBe(false);
    expect(mpp.receipt.receipt.model).toBe("mpp-charge");
  });

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

describe("settlement lock across processes", () => {
  const headers = { [PAYMENT_SIGNATURE_HEADER]: "mock-signed-auth-entry" };

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
      payment: { model: "x402", paymentSignature: headers[PAYMENT_SIGNATURE_HEADER] },
      offer: { ...config, resource: baseRequest.url, models: ["x402"] },
    });
    if (!verification.valid) throw new Error("expected the mock to accept the payment");
    const otherProcess = createRedisSettlementCache({ client, keyPrefix });
    await expect(otherProcess.acquire(`x402:${verification.nonce}`, 30_000)).resolves.toBe(true);

    const outcome = await gate({ ...baseRequest, headers });
    expect(outcome).toEqual({ kind: "rejected", status: 409, reason: "settlement in progress" });
    expect(calls.settle).toBe(0);
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
