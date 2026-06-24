import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@tollway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createMockMppChargeHandler } from "./mpp-charge.js";
import { createPaywall, type PaywallConfig, type TollwayRequest } from "./gate.js";
import { decodeHeader, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./headers.js";

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
