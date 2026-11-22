import { Ed25519Signer } from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator, type FacilitatorClient, type SettleResult } from "./facilitator.js";
import {
  createPaywall,
  type GateOutcome,
  type PaywallConfig,
  type TollwayRequest,
} from "./gate.js";
import { encodePaymentSignatureHeader, PAYMENT_SIGNATURE_HEADER } from "./headers.js";
import {
  createInMemoryServicePolicyStore,
  SERVICE_POLICY_DENIALS,
  type ServicePolicy,
  type ServicePolicyStore,
} from "./service-policy.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
} satisfies PaywallConfig;

const baseRequest: TollwayRequest = {
  method: "GET",
  url: "/quotes/latest",
  headers: {},
};

function paymentHeader(transaction: string): string {
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

function paidRequest(transaction: string): TollwayRequest {
  return { ...baseRequest, headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader(transaction) } };
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("service-policy-test");
});

type GateOptions = {
  payer?: string;
  clock?: () => number;
  store?: ServicePolicyStore;
  settle?: () => Promise<SettleResult>;
  onServicePolicyError?: (error: Error, payer: string) => void;
};

/** A gate whose facilitator has one fixed payer and a controllable settle. */
function makeGate(policy: ServicePolicy, options: GateOptions = {}) {
  const base = createMockFacilitator();
  const defaultSettle = async (): Promise<SettleResult> => ({
    settled: true,
    txHash: "a".repeat(64),
  });
  const settle = vi.fn(options.settle ?? defaultSettle);
  const facilitator: FacilitatorClient = {
    ...base,
    async verify({ payment }) {
      const nonce = await base.idempotencyKey?.({ payment });
      return { valid: true, payer: options.payer ?? "GPAYER", nonce: nonce ?? "nonce" };
    },
    settle,
  };
  const gate = createPaywall(config, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
    servicePolicy: policy,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.store ? { servicePolicyStore: options.store } : {}),
    ...(options.onServicePolicyError ? { onServicePolicyError: options.onServicePolicyError } : {}),
  });
  return { gate, settle };
}

function rejection(outcome: GateOutcome) {
  if (outcome.kind !== "rejected") throw new Error(`expected a rejection, got ${outcome.kind}`);
  return outcome;
}

async function admitDirect(
  store: ServicePolicyStore,
  policy: ServicePolicy,
  payer: string,
  asset: string,
  amount: string,
  now: number,
) {
  return store.admit({
    policy,
    payer,
    model: "x402",
    now,
    offer: { ...config, resource: "/quotes/latest", amount, asset, models: ["x402"] },
  });
}

describe("service policy allow and deny lists", () => {
  it("serves a payer on the allowlist and denies a payer missing from it", async () => {
    const allowed = makeGate({ allowPayers: ["GALLOWED"] }, { payer: "GALLOWED" });
    expect((await allowed.gate(paidRequest("allowed-payer"))).kind).toBe("settled");

    const denied = makeGate({ allowPayers: ["GALLOWED"] }, { payer: "GOTHER" });
    const outcome = rejection(await denied.gate(paidRequest("other-payer")));
    expect(outcome).toMatchObject({
      status: 403,
      reason: SERVICE_POLICY_DENIALS.notAllowed,
    });
    expect(outcome.headers).toBeUndefined();
    expect(denied.settle).not.toHaveBeenCalled();
  });

  it("denies a denylisted payer with the same answer as an allowlist miss", async () => {
    const denylisted = makeGate({ denyPayers: ["GBLOCKED"] }, { payer: "GBLOCKED" });
    const allowlistMiss = makeGate({ allowPayers: ["GALLOWED"] }, { payer: "GBLOCKED" });

    const denied = rejection(await denylisted.gate(paidRequest("denylisted")));
    const missing = rejection(await allowlistMiss.gate(paidRequest("denylisted")));
    expect({ status: denied.status, reason: denied.reason }).toEqual({
      status: missing.status,
      reason: missing.reason,
    });
    expect(denylisted.settle).not.toHaveBeenCalled();
    expect(allowlistMiss.settle).not.toHaveBeenCalled();
  });

  it("serves a payer that is not on a configured denylist", async () => {
    const gate = makeGate({ denyPayers: ["GBLOCKED"] }, { payer: "GFINE" });
    expect((await gate.gate(paidRequest("fine-payer"))).kind).toBe("settled");
  });
});

describe("service policy windows", () => {
  it("limits requests per payer and rolls the window over on the injected clock", async () => {
    let now = 0;
    const { gate, settle } = makeGate(
      { requestsPerWindow: { limit: 2, windowSeconds: 60 } },
      { clock: () => now },
    );

    expect((await gate(paidRequest("req-1"))).kind).toBe("settled");
    expect((await gate(paidRequest("req-2"))).kind).toBe("settled");
    const denied = rejection(await gate(paidRequest("req-3")));
    expect(denied).toMatchObject({
      status: 429,
      reason: SERVICE_POLICY_DENIALS.rateLimited,
      headers: { "retry-after": "60" },
    });
    expect(settle).toHaveBeenCalledTimes(2);

    now = 60_000;
    expect((await gate(paidRequest("req-4"))).kind).toBe("settled");
    expect(settle).toHaveBeenCalledTimes(3);
  });

  it("limits spend per payer and reports the remaining window in Retry-After", async () => {
    let now = 30_000;
    const { gate, settle } = makeGate(
      { spendPerWindow: { limit: "10000", windowSeconds: 60 } },
      { clock: () => now },
    );

    expect((await gate(paidRequest("spend-1"))).kind).toBe("settled");
    now = 45_000;
    const denied = rejection(await gate(paidRequest("spend-2")));
    expect(denied).toMatchObject({
      status: 429,
      reason: SERVICE_POLICY_DENIALS.spendExceeded,
      headers: { "retry-after": "15" },
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("tracks spend per asset rather than across assets", async () => {
    const policy = { spendPerWindow: { limit: "100", windowSeconds: 60 } } satisfies ServicePolicy;
    const store = createInMemoryServicePolicyStore();
    const first = await admitDirect(store, policy, "GPAYER", "USDC:A", "100", 0);
    if (!first.allowed) throw new Error("expected the first asset to be allowed");
    if (first.reservation) await store.commit(first.reservation);

    const exhausted = await admitDirect(store, policy, "GPAYER", "USDC:A", "100", 0);
    expect(exhausted).toEqual({
      allowed: false,
      code: SERVICE_POLICY_DENIALS.spendExceeded,
      retryAfterMs: 60_000,
    });

    const otherAsset = await admitDirect(store, policy, "GPAYER", "USDC:B", "100", 0);
    expect(otherAsset.allowed).toBe(true);
  });

  it("records nothing for a failed settlement", async () => {
    let attempts = 0;
    const { gate, settle } = makeGate(
      { spendPerWindow: { limit: "10000", windowSeconds: 60 } },
      {
        async settle() {
          attempts += 1;
          return attempts === 1
            ? { settled: false, reason: "declined" }
            : { settled: true, txHash: "b".repeat(64) };
        },
      },
    );

    const failed = rejection(await gate(paidRequest("failed-settlement")));
    expect(failed.status).toBe(502);
    expect((await gate(paidRequest("retry-settlement"))).kind).toBe("settled");
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("does not count a replayed receipt against the limit twice", async () => {
    const { gate, settle } = makeGate({
      requestsPerWindow: { limit: 2, windowSeconds: 60 },
    });

    const first = await gate(paidRequest("replay-me"));
    const replay = await gate(paidRequest("replay-me"));
    expect(first.kind).toBe("settled");
    expect(replay).toMatchObject({ kind: "settled", replayed: true });

    // One slot for the first payment, one for this one: the replay added none.
    expect((await gate(paidRequest("after-replay"))).kind).toBe("settled");
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("admits only one of two concurrent requests that fit the cap once", async () => {
    const { gate, settle } = makeGate({
      spendPerWindow: { limit: "10000", windowSeconds: 60 },
    });

    const outcomes = await Promise.all([
      gate(paidRequest("concurrent-a")),
      gate(paidRequest("concurrent-b")),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === "settled")).toHaveLength(1);
    const denied = outcomes.find((outcome) => outcome.kind === "rejected");
    expect(denied).toMatchObject({
      kind: "rejected",
      status: 429,
      reason: SERVICE_POLICY_DENIALS.spendExceeded,
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("service policy on the settlement path", () => {
  it("settles and counts one payment once when the same payment arrives twice at once", async () => {
    const store = createInMemoryServicePolicyStore();
    const admit = vi.spyOn(store, "admit");
    const { gate, settle } = makeGate(
      { spendPerWindow: { limit: "100000", windowSeconds: 60 } },
      { store },
    );

    const outcomes = await Promise.all([
      gate(paidRequest("same-payment")),
      gate(paidRequest("same-payment")),
    ]);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["settled", "settled"]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("gives the second copy of a denied payment the same denial without admitting it again", async () => {
    const store = createInMemoryServicePolicyStore();
    const admit = vi.spyOn(store, "admit");
    const { gate, settle } = makeGate({ allowPayers: ["GSOMEONE-ELSE"] }, { store });

    const outcomes = await Promise.all([
      gate(paidRequest("denied-payment")),
      gate(paidRequest("denied-payment")),
    ]);

    for (const outcome of outcomes) {
      expect(rejection(outcome).reason).toBe(SERVICE_POLICY_DENIALS.notAllowed);
    }
    expect(admit).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it("returns the receipt when recording spend fails after the payment settled", async () => {
    const inner = createInMemoryServicePolicyStore();
    const storeFailure = new Error("policy store unavailable");
    const store: ServicePolicyStore = {
      admit: (input) => inner.admit(input),
      release: (reservation) => inner.release(reservation),
      commit: async () => {
        throw storeFailure;
      },
    };
    const onServicePolicyError = vi.fn();
    const { gate } = makeGate(
      { requestsPerWindow: { limit: 5, windowSeconds: 60 } },
      { store, onServicePolicyError },
    );

    const outcome = await gate(paidRequest("paid-then-store-fails"));

    expect(outcome.kind).toBe("settled");
    expect(onServicePolicyError).toHaveBeenCalledWith(storeFailure, "GPAYER");
  });

  it("keeps the settlement error when releasing the reservation also fails", async () => {
    const inner = createInMemoryServicePolicyStore();
    const settleFailure = new Error("facilitator unreachable");
    const releaseFailure = new Error("policy store unavailable");
    const store: ServicePolicyStore = {
      admit: (input) => inner.admit(input),
      commit: (reservation) => inner.commit(reservation),
      release: async () => {
        throw releaseFailure;
      },
    };
    const onServicePolicyError = vi.fn();
    const { gate } = makeGate(
      { requestsPerWindow: { limit: 5, windowSeconds: 60 } },
      {
        store,
        onServicePolicyError,
        settle: async () => {
          throw settleFailure;
        },
      },
    );

    await expect(gate(paidRequest("settle-throws"))).rejects.toBe(settleFailure);
    expect(onServicePolicyError).toHaveBeenCalledWith(releaseFailure, "GPAYER");
  });
});

describe("in-memory service policy store", () => {
  it("evicts the least recently used payer at the memory bound", async () => {
    const store = createInMemoryServicePolicyStore({ maxPayers: 2 });
    const policy = { requestsPerWindow: { limit: 2, windowSeconds: 60 } } satisfies ServicePolicy;
    const admitted = async (payer: string) => {
      const decision = await admitDirect(store, policy, payer, config.asset, "1", 0);
      return decision.allowed;
    };

    expect(await admitted("GPAYER-A")).toBe(true);
    expect(await admitted("GPAYER-A")).toBe(true);
    expect(await admitted("GPAYER-A")).toBe(false);
    expect(await admitted("GPAYER-B")).toBe(true);
    // Adding C evicts A, so A's next request starts with a fresh window.
    expect(await admitted("GPAYER-C")).toBe(true);
    expect(await admitted("GPAYER-A")).toBe(true);
  });

  it("refuses an invalid policy at construction", () => {
    expect(() =>
      createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        servicePolicy: { requestsPerWindow: { limit: 0 } },
      }),
    ).toThrow(/requestsPerWindow.limit/);
    expect(() =>
      createPaywall(config, {
        signer,
        facilitator: createMockFacilitator(),
        servicePolicy: { spendPerWindow: { limit: "1.5" } },
      }),
    ).toThrow(/integer string/);
  });
});
