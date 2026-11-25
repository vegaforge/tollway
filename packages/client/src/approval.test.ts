/**
 * Tests for payment approval (#199).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalDeniedError,
  ApprovalTimeoutError,
  createClient,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientEvent,
  type SignedReceipt,
} from "./index.js";
import type { PaymentOffer } from "@vegaforge/tollway-core";

const OFFER: PaymentOffer = {
  amount: "10000",
  asset: "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP",
  payTo: "GBTESTPAYEE",
  resource: "/api/test",
  network: "testnet",
  models: ["x402"],
};

function mockSettler() {
  const settle = vi.fn(async () => ({
    receipt: {
      payer: "GTESTPAYER",
      payee: OFFER.payTo,
      amount: OFFER.amount,
      asset: OFFER.asset,
      resource: OFFER.resource,
      network: "testnet",
      model: "x402" as const,
      settlementRef: "tx123",
      issuedAt: new Date().toISOString(),
    },
    signature: "mocksig",
    publicKey: "mockkey",
  } as SignedReceipt));
  return { settle };
}

describe("Payment approval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires approval when amount meets threshold", async () => {
    const approver = vi.fn(async () => ({ approved: true }) as ApprovalDecision);
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
        timeoutMs: 60000,
      },
    });

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    expect(approver).toHaveBeenCalledOnce();
    expect(approver).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: OFFER.resource,
        amount: OFFER.amount,
        asset: OFFER.asset,
        payee: OFFER.payTo,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws ApprovalDeniedError when approver denies", async () => {
    const approver = vi.fn(async () => ({
      approved: false,
      reason: "too expensive",
    }) as ApprovalDecision);
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
      },
    });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toThrow(
      ApprovalDeniedError,
    );
    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toMatchObject({
      code: "approval-denied",
      reason: "too expensive",
    });
  });

  it("throws ApprovalTimeoutError when approver times out", async () => {
    const approver = vi.fn(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ approved: true }), 70000);
        }),
    );
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
        timeoutMs: 60000,
      },
    });

    const promise = client.pay({ resource: OFFER.resource, offer: OFFER });
    await vi.advanceTimersByTimeAsync(60000);

    await expect(promise).rejects.toThrow(ApprovalTimeoutError);
    await expect(promise).rejects.toMatchObject({
      code: "approval-timeout",
    });
  });

  it("treats approver throw as denial", async () => {
    const approver = vi.fn(async () => {
      throw new Error("network failure");
    });
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
      },
    });

    await expect(client.pay({ resource: OFFER.resource, offer: OFFER })).rejects.toThrow(
      ApprovalDeniedError,
    );
  });

  it("emits approval:requested and approval:resolved events", async () => {
    const approver = vi.fn(async () => ({ approved: true }) as ApprovalDecision);
    const settler = mockSettler();
    const events: ClientEvent[] = [];
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
      },
    });
    client.on((event) => events.push(event));

    await client.pay({ resource: OFFER.resource, offer: OFFER });

    const requested = events.find((e) => e.type === "approval:requested");
    expect(requested).toMatchObject({
      type: "approval:requested",
      resource: OFFER.resource,
      amount: OFFER.amount,
      asset: OFFER.asset,
    });

    const resolved = events.find((e) => e.type === "approval:resolved");
    expect(resolved).toMatchObject({
      type: "approval:resolved",
      resource: OFFER.resource,
      approved: true,
    });
    expect((resolved as any).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("skips approval when amount is below threshold", async () => {
    const approver = vi.fn(async () => ({ approved: true }) as ApprovalDecision);
    const settler = mockSettler();
    const lowOffer = { ...OFFER, amount: "5000" };
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
      },
    });

    await client.pay({ resource: lowOffer.resource, offer: lowOffer });

    expect(approver).not.toHaveBeenCalled();
  });

  it("requires approval when predicate returns true", async () => {
    const approver = vi.fn(async () => ({ approved: true }) as ApprovalDecision);
    const settler = mockSettler();
    const lowOffer = { ...OFFER, amount: "100" };
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        predicate: (intent) => intent.payee === OFFER.payTo,
        approver,
      },
    });

    await client.pay({ resource: lowOffer.resource, offer: lowOffer });

    expect(approver).toHaveBeenCalledOnce();
  });

  it("fires AbortSignal on timeout", async () => {
    let signalAborted = false;
    const approver = vi.fn(async (_req, { signal }) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 70000);
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
      });
      return { approved: true };
    });
    const settler = mockSettler();
    const client = createClient({
      network: "testnet",
      settler,
      approval: {
        thresholds: { [OFFER.asset]: "10000" },
        approver,
        timeoutMs: 60000,
      },
    });

    const promise = client.pay({ resource: OFFER.resource, offer: OFFER });
    await vi.advanceTimersByTimeAsync(60000);

    await expect(promise).rejects.toThrow(ApprovalTimeoutError);
    expect(signalAborted).toBe(true);
  });
});
