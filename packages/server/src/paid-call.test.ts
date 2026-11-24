import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";
import type { PaymentPayload } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaidCall, type PaidCallConfig } from "./gate.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
  resource: "mcp://tool/get-quote",
} satisfies PaidCallConfig;

function payment(transaction = "mock-signed-auth-entry"): PaymentPayload {
  return {
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
  };
}

/** The mock facilitator with spies on verify and settle. */
function spiedFacilitator(): FacilitatorClient & {
  settle: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  const base = createMockFacilitator();
  return {
    ...base,
    verify: vi.fn(base.verify),
    settle: vi.fn(base.settle),
  };
}

let signer: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("paid-call-test");
});

describe("createPaidCall (#206)", () => {
  it("builds an x402 V2 PaymentRequired for the call's resource", () => {
    const call = createPaidCall(
      { ...config, description: "Latest quote" },
      { signer, facilitator: createMockFacilitator() },
    );
    const challenge = call.paymentRequired("Payment required");
    expect(challenge).toMatchObject({
      x402Version: 2,
      error: "Payment required",
      resource: { url: config.resource, description: "Latest quote" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: config.amount,
          asset: config.asset,
          payTo: config.payTo,
          maxTimeoutSeconds: 60,
        },
      ],
    });
    expect(call.paymentRequired()).not.toHaveProperty("error");
  });

  it("verifies, runs the work, then settles and signs a receipt bound to the call", async () => {
    const facilitator = spiedFacilitator();
    const order: string[] = [];
    facilitator.verify.mockImplementation(async (input) => {
      order.push("verify");
      return createMockFacilitator().verify(input);
    });
    facilitator.settle.mockImplementation(async (input) => {
      order.push("settle");
      return createMockFacilitator().settle(input);
    });
    const call = createPaidCall(config, { signer, facilitator, receiptVersion: 2 });

    const outcome = await call.settle({
      payment: payment(),
      method: "tools/call",
      beforeSettle: async () => {
        order.push("work");
        return true;
      },
    });

    expect(order).toEqual(["verify", "work", "settle"]);
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.replayed).toBe(false);
    const verification = await verifyReceipt(
      outcome.receipt,
      await Ed25519Verifier.forSigner(signer),
    );
    expect(verification.valid).toBe(true);
    expect(outcome.receipt.receipt).toMatchObject({
      resource: config.resource,
      amount: config.amount,
      asset: config.asset,
      payee: config.payTo,
      network: "testnet",
      model: "x402",
      method: "tools/call",
    });
  });

  it("does not settle or cache when the work fails, so the payment stays usable", async () => {
    const facilitator = spiedFacilitator();
    const cache = createInMemorySettlementCache();
    const call = createPaidCall(config, { signer, facilitator, cache });

    const failed = await call.settle({
      payment: payment(),
      method: "tools/call",
      beforeSettle: async () => false,
    });
    expect(failed).toMatchObject({ kind: "rejected", status: 424 });
    expect(facilitator.settle).not.toHaveBeenCalled();

    const retried = await call.settle({
      payment: payment(),
      method: "tools/call",
      beforeSettle: async () => true,
    });
    expect(retried).toMatchObject({ kind: "settled", replayed: false });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("does not settle when the work throws, and surfaces the error", async () => {
    const facilitator = spiedFacilitator();
    const call = createPaidCall(config, { signer, facilitator });

    await expect(
      call.settle({
        payment: payment(),
        method: "tools/call",
        beforeSettle: async () => {
          throw new Error("upstream down");
        },
      }),
    ).rejects.toThrow("upstream down");
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("replays a settled payment from the cache without running the work or settling again", async () => {
    const facilitator = spiedFacilitator();
    const cache = createInMemorySettlementCache();
    const call = createPaidCall(config, { signer, facilitator, cache });
    const work = vi.fn(async () => true);

    const first = await call.settle({
      payment: payment(),
      method: "tools/call",
      beforeSettle: work,
    });
    const replay = await call.settle({
      payment: payment(),
      method: "tools/call",
      beforeSettle: work,
    });

    expect(first.kind).toBe("settled");
    expect(replay).toMatchObject({ kind: "settled", replayed: true });
    if (first.kind !== "settled" || replay.kind !== "settled") return;
    expect(replay.receipt).toEqual(first.receipt);
    expect(work).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("settles two concurrent copies of one payment once and runs the work once", async () => {
    const facilitator = spiedFacilitator();
    const call = createPaidCall(config, { signer, facilitator });
    const work = vi.fn(async () => true);

    const [a, b] = await Promise.all([
      call.settle({ payment: payment(), method: "tools/call", beforeSettle: work }),
      call.settle({ payment: payment(), method: "tools/call", beforeSettle: work }),
    ]);

    expect(a.kind).toBe("settled");
    expect(b.kind).toBe("settled");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("refuses a cached receipt for another resource sharing the cache", async () => {
    const cache = createInMemorySettlementCache();
    const facilitator = createMockFacilitator();
    const quote = createPaidCall(config, { signer, facilitator, cache });
    const other = createPaidCall(
      { ...config, resource: "mcp://tool/other" },
      { signer, facilitator, cache },
    );

    await quote.settle({ payment: payment(), method: "tools/call" });
    const outcome = await other.settle({ payment: payment(), method: "tools/call" });
    expect(outcome).toMatchObject({ kind: "rejected", status: 409 });
  });

  it("rejects an x402 V1 payload and a payment the facilitator does not verify", async () => {
    const call = createPaidCall(config, { signer, facilitator: createMockFacilitator() });
    await expect(
      call.settle({ payment: { ...payment(), x402Version: 1 }, method: "tools/call" }),
    ).resolves.toMatchObject({ kind: "rejected", status: 400 });
    await expect(
      call.settle({ payment: payment(""), method: "tools/call" }),
    ).resolves.toMatchObject({ kind: "rejected", status: 402 });
  });

  it("refuses a config it cannot charge for", () => {
    const deps = { signer, facilitator: createMockFacilitator() };
    expect(() => createPaidCall({ ...config, amount: "1.5" }, deps)).toThrow(/amount/);
    expect(() => createPaidCall({ ...config, resource: "" }, deps)).toThrow(/resource/);
    expect(() => createPaidCall({ ...config, models: ["mpp-charge"] }, deps)).toThrow(/x402/);
  });
});
