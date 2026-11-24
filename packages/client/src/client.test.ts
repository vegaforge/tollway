import {
  buildReceipt,
  canonicalJson,
  createDefaultRouter,
  createMemoryQuarantine,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  policyTraceSchema,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ClientEvent,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  ReceiptVerificationError,
} from "./index.js";
import { createMemoryReceiptStore, type ReceiptStore } from "./receipt-store.js";

const OFFER: PaymentOffer = {
  resource: "/quotes/latest",
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  models: ["x402"],
};

let signer: Ed25519Signer;
let verifier: Ed25519Verifier;
let baselineReceipt: SignedReceipt;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-client-key");
  verifier = Ed25519Verifier.forSigner(signer);
  baselineReceipt = await signReceipt(
    buildReceipt({
      payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: OFFER.payTo,
      amount: OFFER.amount,
      asset: OFFER.asset,
      resource: OFFER.resource,
      model: "x402",
      settlement: { kind: "transaction", txHash: "abc123" },
      network: "testnet",
    }),
    signer,
  );
});

function mockSettler(receipt: SignedReceipt = baselineReceipt): ClientSettler {
  return {
    settle: vi.fn().mockResolvedValue(receipt),
  };
}

describe("createClient happy path", () => {
  it("runs settle and returns a verified receipt for an x402 offer", async () => {
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      verifier,
    });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(result.model).toBe("x402");
    expect(result.receipt).toEqual(baselineReceipt);
    expect(settler.settle).toHaveBeenCalledWith({
      resource: OFFER.resource,
      offer: OFFER,
      model: "x402",
    });
  });

  it("defaults to x402 when no router is configured and no model is supplied", async () => {
    const settler = mockSettler();
    const client = createClient({ network: "testnet", settler });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(result.model).toBe("x402");
  });

  it("emits a payment event with the resource, model, and receipt on success", async () => {
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: mockSettler() });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "payment",
      resource: OFFER.resource,
      model: "x402",
    });
  });

  it("honours an explicit model override on the request", async () => {
    const settler = mockSettler();
    const client = createClient({ network: "testnet", settler });

    const result = await client.pay({
      resource: OFFER.resource,
      offer: OFFER,
      model: "mpp-charge",
    });

    expect(result.model).toBe("mpp-charge");
    expect(settler.settle).toHaveBeenCalledWith(expect.objectContaining({ model: "mpp-charge" }));
  });

  it("delegates the model decision to the router when one is configured", async () => {
    const settler = mockSettler();
    const router = {
      decide: vi.fn().mockResolvedValue({ model: "mpp-charge", reason: "traffic" }),
    };
    const client = createClient({ network: "testnet", settler, router });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(router.decide).toHaveBeenCalledWith({
      counterparty: OFFER.payTo,
      resource: OFFER.resource,
      offer: OFFER,
    });
    expect(result.model).toBe("mpp-charge");
  });

  it("records the settlement on the policy engine so subsequent budgets advance", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "20000" } });
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    // After spending 10000 against a 20000 daily budget, another 10000 fits;
    // a third 10000 must exceed and produce a policy block.
    await client.pay({ resource: OFFER.resource, offer: OFFER });
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      PolicyBlockedError,
    );
  });
});

describe("createClient policy + budget exhaustion", () => {
  it("throws PolicyBlockedError and emits skip when the policy blocks the payment", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const settler = mockSettler();
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler, policy });
    client.on((event) => events.push(event));

    // First payment of 10000 already exceeds the 5000 daily budget.
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      PolicyBlockedError,
    );

    expect(settler.settle).not.toHaveBeenCalled();
    const skipEvent = events.find((e) => e.type === "skip");
    expect(skipEvent).toBeDefined();
    if (skipEvent && skipEvent.type === "skip") {
      expect(skipEvent.reason).toMatch(/budget/);
    }
  });

  it("attaches the rule and detail to PolicyBlockedError so callers can branch", async () => {
    const policy = createPolicyEngine({
      perModel: { "mpp-channel": { enabled: false } },
    });
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });

    await expect(
      client.pay({ resource: OFFER.resource, offer: OFFER, model: "mpp-channel" }),
    ).rejects.toMatchObject({
      name: "PolicyBlockedError",
      code: "policy-blocked",
      rule: "per-model-disabled",
    });
  });

  it("composes with the TollwayError code model so cross-package callers can branch on .code", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });

    const error = await client.pay({ resource: OFFER.resource, offer: OFFER }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PolicyBlockedError);
    expect(error).toBeInstanceOf(TollwayError);
    if (error instanceof TollwayError) {
      expect(error.code).toBe("policy-blocked");
    }
  });
});

describe("createClient receipt verification", () => {
  it("throws ReceiptVerificationError with the receipt-verification-failed code when tampered", async () => {
    // Mutate the body after signing so the signature no longer covers the canonical bytes.
    const tampered: SignedReceipt = {
      ...baselineReceipt,
      receipt: { ...baselineReceipt.receipt, amount: "99999999999" },
    };
    const client = createClient({
      network: "testnet",
      settler: mockSettler(tampered),
      verifier,
    });

    const error = await client.pay({ resource: OFFER.resource, offer: OFFER }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReceiptVerificationError);
    expect(error).toBeInstanceOf(TollwayError);
    if (error instanceof TollwayError) {
      expect(error.code).toBe("receipt-verification-failed");
    }
  });

  it("skips verification when no verifier is configured (best-effort default)", async () => {
    const tampered: SignedReceipt = {
      ...baselineReceipt,
      receipt: { ...baselineReceipt.receipt, amount: "99999999999" },
    };
    const client = createClient({ network: "testnet", settler: mockSettler(tampered) });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });
    expect(result.receipt).toEqual(tampered);
  });
});

describe("createClient error events", () => {
  it("emits an error event when the settler rejects", async () => {
    const settler: ClientSettler = {
      settle: vi.fn().mockRejectedValue(new Error("facilitator down")),
    };
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler });
    client.on((event) => events.push(event));

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toThrow(
      "facilitator down",
    );

    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    if (errEvent && errEvent.type === "error") {
      expect(errEvent.resource).toBe(OFFER.resource);
      expect(errEvent.error.message).toBe("facilitator down");
    }
  });

  it("does not record on the policy engine when settlement fails", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "20000" } });
    const failingSettler: ClientSettler = {
      settle: vi.fn().mockRejectedValue(new Error("network")),
    };
    const client = createClient({ network: "testnet", settler: failingSettler, policy });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toThrow("network");

    // A subsequent successful payment of 10000 must still fit under the 20000
    // budget; if the failed attempt had been recorded, this would block.
    const recovered = createClient({ network: "testnet", settler: mockSettler(), policy });
    await expect(recovered.pay({ resource: OFFER.resource, offer: OFFER })).resolves.toMatchObject({
      model: "x402",
    });
    await expect(recovered.pay({ resource: OFFER.resource, offer: OFFER })).resolves.toMatchObject({
      model: "x402",
    });
  });

  it("does not let a throwing event handler poison the pay() promise", async () => {
    const client = createClient({ network: "testnet", settler: mockSettler() });
    client.on(() => {
      throw new Error("bad observer");
    });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).resolves.toMatchObject({
      model: "x402",
    });
  });
});

// Regression lock for ADR-2026-11-18-strict-receipt-verification.
describe("createClient returns only signed receipt fields", () => {
  it("rejects a receipt carrying a field the signature does not cover", async () => {
    const padded = {
      ...baselineReceipt,
      receipt: { ...baselineReceipt.receipt, refunded: "true" },
    } as unknown as SignedReceipt;
    const client = createClient({ network: "testnet", settler: mockSettler(padded), verifier });
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      ReceiptVerificationError,
    );
  });

  it("does not hand back settler output as is when no verifier is set", async () => {
    const padded = { ...baselineReceipt, extra: 1 } as SignedReceipt;
    const client = createClient({ network: "testnet", settler: mockSettler(padded) });
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      TollwayError,
    );
  });
});

describe("createClient policy decision events", () => {
  it("emits the active policy's full trace before paying", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "20000" } });
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    const decision = events.find((e) => e.type === "policy:decision");
    if (decision?.type !== "policy:decision") throw new Error("no policy:decision event");
    expect(policyTraceSchema.parse(decision.trace)).toEqual(decision.trace);
    expect(decision.trace).toMatchObject({ version: 1, mode: "enforce", allowed: true });
    expect(decision.trace.entries.find((e) => e.id === "budget-daily")).toMatchObject({
      outcome: "pass",
      limit: "20000",
      current: "0",
      projected: "10000",
    });
    // The decision comes first, the payment after it.
    expect(events.map((e) => e.type)).toEqual(["policy:decision", "payment"]);
  });

  it("emits a blocking trace that names the same rule as the error", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });
    client.on((event) => events.push(event));

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toMatchObject({
      rule: "budget",
    });
    const decision = events.find((e) => e.type === "policy:decision");
    if (decision?.type !== "policy:decision") throw new Error("no policy:decision event");
    expect(decision.trace).toMatchObject({ allowed: false, blockedBy: "budget-daily" });
  });

  it("does not evaluate twice: one evaluate call per payment, no check call", async () => {
    const inner = createPolicyEngine({});
    const evaluate = vi.fn(inner.evaluate);
    const check = vi.fn(inner.check);
    const policy = { mode: inner.mode, evaluate, check, record: inner.record };
    const client = createClient({ network: "testnet", settler: mockSettler(), policy });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("createClient receipt store", () => {
  function storeWith(put: ReceiptStore["put"]): ReceiptStore {
    return {
      put,
      get: async () => null,
      query: async () => ({ items: [] }),
    };
  }

  it("writes the verified receipt before pay() resolves", async () => {
    let release: (() => void) | undefined;
    const put = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      verifier,
      receiptStore: storeWith(put),
    });

    let resolved = false;
    const paying = client.pay({ resource: OFFER.resource, offer: OFFER }).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => expect(put).toHaveBeenCalledWith(baselineReceipt));
    expect(resolved).toBe(false);

    if (!release) throw new Error("put() was never called, so there is nothing to release");
    release();
    await expect(paying).resolves.toMatchObject({ receipt: baselineReceipt });
  });

  it("stores the receipt so the agent keeps it after pay() returns", async () => {
    const store = createMemoryReceiptStore();
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      receiptStore: store,
    });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    await expect(store.get(baselineReceipt.receipt.id)).resolves.toEqual(baselineReceipt);
  });

  it("keeps the receipt when the store write fails, sets storeError and calls onStoreError", async () => {
    const failure = new Error("disk full");
    const onStoreError = vi.fn();
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      receiptStore: storeWith(vi.fn().mockRejectedValue(failure)),
      onStoreError,
    });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(result.receipt).toEqual(baselineReceipt);
    expect(result.storeError).toBe(failure);
    expect(onStoreError).toHaveBeenCalledWith(failure, baselineReceipt);
  });

  it("still resolves with the receipt when onStoreError itself throws", async () => {
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      receiptStore: storeWith(vi.fn().mockRejectedValue(new Error("disk full"))),
      onStoreError: () => {
        throw new Error("alert hook down");
      },
    });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).resolves.toMatchObject({
      receipt: baselineReceipt,
    });
  });

  it("never stores a receipt that failed verification", async () => {
    const tampered: SignedReceipt = {
      ...baselineReceipt,
      receipt: { ...baselineReceipt.receipt, amount: "99999999999" },
    };
    const put = vi.fn();
    const client = createClient({
      network: "testnet",
      settler: mockSettler(tampered),
      verifier,
      receiptStore: storeWith(put),
    });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      ReceiptVerificationError,
    );
    expect(put).not.toHaveBeenCalled();
  });
});

describe("createClient dry-run", () => {
  it("lets a would-be block through, marks it in the trace, and still records spend", async () => {
    const policy = createPolicyEngine({ mode: "dry-run", budgets: { daily: "5000" } });
    const settler = mockSettler();
    const events: ClientEvent[] = [];
    const client = createClient({
      network: "testnet",
      settler,
      policy,
      logger: { warn: () => undefined },
    });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });
    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(settler.settle).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "skip")).toBe(false);
    const traces = events.flatMap((e) => (e.type === "policy:decision" ? [e.trace] : []));
    expect(traces.map((t) => [t.allowed, t.wouldBlock, t.blockedBy])).toEqual([
      [true, true, "budget-daily"],
      [true, true, "budget-daily"],
    ]);
    // The second evaluation saw the first payment: spend was recorded.
    expect(traces[1]?.entries.find((e) => e.id === "budget-daily")).toMatchObject({
      current: "10000",
      projected: "20000",
    });
    const next = await policy.evaluate({
      payee: OFFER.payTo,
      resource: OFFER.resource,
      amount: "1",
      asset: OFFER.asset,
      model: "x402",
    });
    expect(next.entries.find((e) => e.id === "budget-daily")?.current).toBe("20000");
  });

  it("logs a warning at construction when the policy is in dry-run", () => {
    const warn = vi.fn();
    createClient({
      network: "testnet",
      settler: mockSettler(),
      policy: createPolicyEngine({ mode: "dry-run" }),
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/dry-run/);
  });

  it("does not warn for an enforcing policy, which is the default", () => {
    const warn = vi.fn();
    createClient({
      network: "testnet",
      settler: mockSettler(),
      policy: createPolicyEngine({}),
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createClient shadow policy", () => {
  it("emits the differences between the active and candidate policy without blocking", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "100000" } });
    const shadow = createPolicyEngine({ budgets: { daily: "15000" } });
    const settler = mockSettler();
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler, policy, shadow });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });
    await client.pay({ resource: OFFER.resource, offer: OFFER });

    // The candidate would have blocked the second payment; it went through.
    expect(settler.settle).toHaveBeenCalledTimes(2);
    const comparisons = events.flatMap((e) => (e.type === "policy:shadow" ? [e.comparison] : []));
    expect(comparisons).toEqual([
      { sameDecision: true, activeWouldBlock: false, candidateWouldBlock: false, differences: [] },
      {
        sameDecision: false,
        activeWouldBlock: false,
        candidateWouldBlock: true,
        differences: [{ id: "budget-daily", active: "pass", candidate: "fail" }],
      },
    ]);
  });

  it("records settled spend on the shadow so its budgets stay real", async () => {
    const shadow = createPolicyEngine({ budgets: { daily: "1000000" } });
    const client = createClient({ network: "testnet", settler: mockSettler(), shadow });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    const trace = await shadow.evaluate({
      payee: OFFER.payTo,
      resource: OFFER.resource,
      amount: "1",
      asset: OFFER.asset,
      model: "x402",
    });
    expect(trace.entries.find((e) => e.id === "budget-daily")?.current).toBe("10000");
  });

  it("compares with no policy when there is no active one", async () => {
    const shadow = createPolicyEngine({ budgets: { daily: "5000" } });
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: mockSettler(), shadow });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(events.some((e) => e.type === "policy:decision")).toBe(false);
    const shadowEvent = events.find((e) => e.type === "policy:shadow");
    if (shadowEvent?.type !== "policy:shadow") throw new Error("no policy:shadow event");
    expect(shadowEvent.comparison.differences).toEqual([
      { id: "budget-daily", active: "not-applicable", candidate: "fail" },
    ]);
    expect(events.at(-1)?.type).toBe("payment");
  });

  it("still emits the comparison when the active policy blocks", async () => {
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const shadow = createPolicyEngine({ budgets: { daily: "50000" } });
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: mockSettler(), policy, shadow });
    client.on((event) => events.push(event));

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      PolicyBlockedError,
    );
    const shadowEvent = events.find((e) => e.type === "policy:shadow");
    expect(shadowEvent).toMatchObject({
      comparison: { activeWouldBlock: true, candidateWouldBlock: false },
    });
  });

  it("reports a failing candidate as policy:shadow-error and pays anyway", async () => {
    const shadow = createPolicyEngine({ budgets: { daily: "100000" } });
    vi.spyOn(shadow, "evaluate").mockRejectedValue(
      new TollwayError("invalid-amount", "invalid amount: not-a-number"),
    );
    const settler = mockSettler();
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler, shadow });
    client.on((event) => events.push(event));

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).resolves.toMatchObject({
      model: "x402",
    });
    const shadowError = events.find((e) => e.type === "policy:shadow-error");
    expect(shadowError).toMatchObject({ error: { code: "invalid-amount" } });
    expect(settler.settle).toHaveBeenCalledTimes(1);
  });

  it("skips shadow evaluation entirely when nobody is listening", async () => {
    const inner = createPolicyEngine({ budgets: { daily: "1000000" } });
    const evaluate = vi.fn(inner.evaluate);
    const record = vi.fn(inner.record);
    const shadow = { mode: inner.mode, evaluate, check: inner.check, record };
    const client = createClient({ network: "testnet", settler: mockSettler(), shadow });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(evaluate).not.toHaveBeenCalled();
    // Spend is still recorded, so the shadow is accurate once someone listens.
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("counterparty:quarantined events", () => {
  it("emits counterparty:quarantined and excludes mpp-channel when quarantine is configured", async () => {
    const quarantine = createMemoryQuarantine();
    await quarantine.quarantine({
      counterparty: OFFER.payTo,
      reason: "under-settled by 500",
      drift: { kind: "under-settled", detail: "shortfall 500", channelId: "ch-1" },
    });

    const events: ClientEvent[] = [];
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      router: createDefaultRouter(),
      quarantine,
    });
    client.on((event) => events.push(event));

    const result = await client.pay({
      resource: OFFER.resource,
      offer: { ...OFFER, models: ["mpp-channel", "x402"] },
    });

    expect(result.model).toBe("x402");
    const qEvent = events.find((e) => e.type === "counterparty:quarantined");
    expect(qEvent).toMatchObject({
      type: "counterparty:quarantined",
      counterparty: OFFER.payTo,
      resource: OFFER.resource,
      reason: "under-settled by 500",
      entry: { counterparty: OFFER.payTo },
    });
  });

  it("refuses an explicit mpp-channel request for a quarantined counterparty", async () => {
    // An explicit model skips the router, so the client itself must keep a
    // quarantined counterparty out of channel mode.
    const quarantine = createMemoryQuarantine();
    await quarantine.quarantine({
      counterparty: OFFER.payTo,
      reason: "under-settled by 500",
      drift: { kind: "under-settled", detail: "shortfall 500" },
    });
    const settler = mockSettler();
    const client = createClient({ network: "testnet", settler, quarantine });

    await expect(
      client.pay({
        resource: OFFER.resource,
        offer: { ...OFFER, models: ["mpp-channel", "x402"] },
        model: "mpp-channel",
      }),
    ).rejects.toMatchObject({ code: "counterparty-quarantined" });
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("emits counterparty:quarantined when the router itself flags quarantine", async () => {
    const quarantine = createMemoryQuarantine();
    await quarantine.quarantine({
      counterparty: OFFER.payTo,
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall" },
    });

    const events: ClientEvent[] = [];
    const client = createClient({
      network: "testnet",
      settler: mockSettler(),
      router: createDefaultRouter({ quarantine }),
    });
    client.on((event) => events.push(event));

    const result = await client.pay({
      resource: OFFER.resource,
      offer: { ...OFFER, models: ["mpp-channel", "mpp-charge"] },
    });

    expect(result.model).toBe("mpp-charge");
    const qEvent = events.find((e) => e.type === "counterparty:quarantined");
    expect(qEvent).toMatchObject({
      type: "counterparty:quarantined",
      counterparty: OFFER.payTo,
      resource: OFFER.resource,
    });
  });
});

/**
 * A settler that keeps every settlement open until `release` is called, so a
 * test decides how many calls are in flight at once.
 */
function heldSettler(outcome: SignedReceipt | Error = baselineReceipt) {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const settle = vi.fn(async (): Promise<SignedReceipt> => {
    await held;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const settler: ClientSettler = { settle };
  return { settler, settle, release: () => open() };
}

/** Lets every pay() call already started run up to its first pending await. */
function inFlight(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Regression lock for #210: an agent that fires the same request twice in
// parallel pays once.
describe("createClient concurrent payments", () => {
  it("settles once when two concurrent calls ask for the same resource and offer", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER });
    const second = client.pay({ resource: OFFER.resource, offer: { ...OFFER } });
    await inFlight();
    held.release();
    const [a, b] = await Promise.all([first, second]);

    expect(held.settle).toHaveBeenCalledTimes(1);
    expect(b.receipt).toEqual(a.receipt);
  });

  it("marks which call paid and which call waited", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER });
    const second = client.pay({ resource: OFFER.resource, offer: OFFER });
    await inFlight();
    held.release();

    await expect(first).resolves.toMatchObject({ deduplicated: false, model: "x402" });
    await expect(second).resolves.toMatchObject({ deduplicated: true, model: "x402" });
  });

  it("pays twice when the concurrent offers differ in amount", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER });
    const second = client.pay({ resource: OFFER.resource, offer: { ...OFFER, amount: "20000" } });
    await inFlight();
    held.release();
    const results = await Promise.all([first, second]);

    expect(held.settle).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.deduplicated)).toEqual([false, false]);
  });

  it("pays twice when the same offer goes out on two settlement models", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER, model: "x402" });
    const second = client.pay({ resource: OFFER.resource, offer: OFFER, model: "mpp-charge" });
    await inFlight();
    held.release();
    await Promise.all([first, second]);

    expect(held.settle).toHaveBeenCalledTimes(2);
  });

  it("pays again for a later call, because it is a new purchase", async () => {
    const settler = mockSettler();
    const client = createClient({ network: "testnet", settler });

    const first = await client.pay({ resource: OFFER.resource, offer: OFFER });
    const second = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(settler.settle).toHaveBeenCalledTimes(2);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
  });

  it("rejects every waiter with the settling call's error and records nothing", async () => {
    const failure = new Error("facilitator down");
    const held = heldSettler(failure);
    const inner = createPolicyEngine({ budgets: { daily: "1000000" } });
    const record = vi.fn(inner.record);
    const policy = { mode: inner.mode, evaluate: inner.evaluate, check: inner.check, record };
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: held.settler, policy });
    client.on((event) => events.push(event));

    const calls = [1, 2, 3].map(() => client.pay({ resource: OFFER.resource, offer: OFFER }));
    await inFlight();
    held.release();
    const outcomes = await Promise.allSettled(calls);

    expect(held.settle).toHaveBeenCalledTimes(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      // The same error object, not three copies of it.
      expect(outcome.status === "rejected" && outcome.reason).toBe(failure);
    }
    expect(record).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.some((event) => event.type === "payment:deduplicated")).toBe(false);
  });

  it("forgets a failed settlement, so the next call pays", async () => {
    const settle = vi
      .fn<ClientSettler["settle"]>()
      .mockRejectedValueOnce(new Error("facilitator down"))
      .mockResolvedValue(baselineReceipt);
    const client = createClient({ network: "testnet", settler: { settle } });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toThrow(
      "facilitator down",
    );
    const retried = await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(settle).toHaveBeenCalledTimes(2);
    expect(retried.deduplicated).toBe(false);
  });

  it("shares a policy block with every waiter without reaching the settler", async () => {
    const held = heldSettler();
    const policy = createPolicyEngine({ budgets: { daily: "5000" } });
    const client = createClient({ network: "testnet", settler: held.settler, policy });

    const calls = [1, 2].map(() => client.pay({ resource: OFFER.resource, offer: OFFER }));
    const outcomes = await Promise.allSettled(calls);

    expect(held.settle).not.toHaveBeenCalled();
    const reasons = outcomes.map((outcome) => outcome.status === "rejected" && outcome.reason);
    expect(reasons[0]).toBeInstanceOf(PolicyBlockedError);
    expect(reasons[1]).toBe(reasons[0]);
  });

  it("evaluates and records the policy once for N concurrent identical calls", async () => {
    const held = heldSettler();
    const inner = createPolicyEngine({ budgets: { daily: OFFER.amount } });
    const evaluate = vi.fn(inner.evaluate);
    const record = vi.fn(inner.record);
    const policy = { mode: inner.mode, evaluate, check: inner.check, record };
    const client = createClient({ network: "testnet", settler: held.settler, policy });

    const calls = [1, 2, 3].map(() => client.pay({ resource: OFFER.resource, offer: OFFER }));
    await inFlight();
    held.release();
    await Promise.all(calls);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    // The budget covers one payment and one was recorded, so the next is blocked.
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      PolicyBlockedError,
    );
  });

  it("emits exactly one payment event for N concurrent identical calls", async () => {
    const held = heldSettler();
    const events: ClientEvent[] = [];
    const client = createClient({ network: "testnet", settler: held.settler });
    client.on((event) => events.push(event));

    const calls = [1, 2, 3, 4, 5].map(() => client.pay({ resource: OFFER.resource, offer: OFFER }));
    await inFlight();
    held.release();
    await Promise.all(calls);

    expect(held.settle).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "payment")).toHaveLength(1);
    const waiters = events.filter((event) => event.type === "payment:deduplicated");
    expect(waiters).toHaveLength(4);
    for (const waiter of waiters) {
      expect(waiter).toMatchObject({
        resource: OFFER.resource,
        model: "x402",
        receipt: baselineReceipt,
      });
    }
  });

  it("stores the receipt once for N concurrent identical calls", async () => {
    const held = heldSettler();
    const put = vi.fn().mockResolvedValue(undefined);
    const client = createClient({
      network: "testnet",
      settler: held.settler,
      receiptStore: { put, get: async () => null, query: async () => ({ items: [] }) },
    });

    const calls = [1, 2, 3].map(() => client.pay({ resource: OFFER.resource, offer: OFFER }));
    await inFlight();
    held.release();
    await Promise.all(calls);

    expect(put).toHaveBeenCalledTimes(1);
  });

  it("shares one settlement across different offers when the idempotencyKey matches", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({
      resource: OFFER.resource,
      offer: OFFER,
      idempotencyKey: "order-42",
    });
    const second = client.pay({
      resource: "/quotes/latest?retry=1",
      offer: { ...OFFER, amount: "20000" },
      idempotencyKey: "order-42",
    });
    await inFlight();
    held.release();
    const [a, b] = await Promise.all([first, second]);

    // The first call's offer is the one that was paid.
    expect(held.settle).toHaveBeenCalledTimes(1);
    expect(held.settle).toHaveBeenCalledWith({
      resource: OFFER.resource,
      offer: OFFER,
      model: "x402",
    });
    expect(b).toMatchObject({ deduplicated: true, receipt: a.receipt });
  });

  it("never shares a settlement when the idempotencyKey differs", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER, idempotencyKey: "a" });
    const second = client.pay({ resource: OFFER.resource, offer: OFFER, idempotencyKey: "b" });
    const third = client.pay({ resource: OFFER.resource, offer: OFFER });
    await inFlight();
    held.release();
    const results = await Promise.all([first, second, third]);

    expect(held.settle).toHaveBeenCalledTimes(3);
    expect(results.map((result) => result.deduplicated)).toEqual([false, false, false]);
  });

  it("keeps a caller's key apart from a derived key that spells the same", async () => {
    const held = heldSettler();
    const client = createClient({ network: "testnet", settler: held.settler });
    const derived = canonicalJson({
      resource: OFFER.resource,
      model: "x402",
      amount: OFFER.amount,
      asset: OFFER.asset,
      payTo: OFFER.payTo,
      network: OFFER.network,
    });

    const first = client.pay({ resource: OFFER.resource, offer: OFFER });
    const second = client.pay({ resource: OFFER.resource, offer: OFFER, idempotencyKey: derived });
    await inFlight();
    held.release();
    await Promise.all([first, second]);

    expect(held.settle).toHaveBeenCalledTimes(2);
  });
});
