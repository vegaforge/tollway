import {
  buildReceipt,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
} from "@tollway/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ClientEvent,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  ReceiptVerificationError,
} from "./index.js";

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
    expect(result.receipt).toBe(baselineReceipt);
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
      rule: "per-model-disabled",
    });
  });
});

describe("createClient receipt verification", () => {
  it("throws ReceiptVerificationError when the returned receipt is tampered", async () => {
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

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toBeInstanceOf(
      ReceiptVerificationError,
    );
  });

  it("skips verification when no verifier is configured (best-effort default)", async () => {
    const tampered: SignedReceipt = {
      ...baselineReceipt,
      receipt: { ...baselineReceipt.receipt, amount: "99999999999" },
    };
    const client = createClient({ network: "testnet", settler: mockSettler(tampered) });

    const result = await client.pay({ resource: OFFER.resource, offer: OFFER });
    expect(result.receipt).toBe(tampered);
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
