import { Ed25519Signer } from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaywall, type PaywallConfig, type PaywallDeps } from "./gate.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { createLatestLedgerSource } from "./stellar-static-validation.js";
import {
  AMOUNT,
  ASSET,
  envelope,
  OTHER_ASSET,
  PAY_TO,
  PAYER,
  REQUIREMENTS,
} from "./testing/stellar-envelopes.js";

/**
 * Issue #159 through the gate: a payment that fails a local static check is
 * refused with a 402 before any facilitator call, and one that passes still
 * goes to /verify, which stays authoritative.
 */

const config = {
  amount: AMOUNT,
  asset: ASSET,
  payTo: PAY_TO,
  network: "testnet",
} satisfies PaywallConfig;

const request = { method: "GET", url: "/quotes/latest", headers: {} };

function paid(transaction: string) {
  return {
    ...request,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: { ...REQUIREMENTS },
        payload: { transaction },
      }),
    },
  };
}

/** A facilitator client that talks to a "real" facilitator: no mock marker. */
function realFacilitator(verdict: "valid" | "invalid" = "valid") {
  const verify = vi.fn(async ({ payment }: Parameters<FacilitatorClient["verify"]>[0]) =>
    verdict === "valid"
      ? { valid: true as const, payer: PAYER.publicKey(), nonce: keyOf(payment) }
      : { valid: false as const, reason: "invalid_exact_stellar_payload_simulation_failed" },
  );
  const settle = vi.fn(async () => ({ settled: true as const, txHash: "ab".repeat(32) }));
  const client: FacilitatorClient = {
    async idempotencyKey({ payment }) {
      return keyOf(payment);
    },
    verify,
    settle,
    async supported() {
      return { kinds: [], extensions: [], signers: {} };
    },
  };
  return { client, verify, settle };
}

function keyOf(payment: Parameters<FacilitatorClient["verify"]>[0]["payment"]): string {
  return String(payment.payload.payload.transaction).slice(-48);
}

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("prevalidation");
});

function gateWith(facilitator: FacilitatorClient, deps: Partial<PaywallDeps> = {}) {
  return createPaywall(config, { signer, facilitator, ...deps });
}

describe("local pre-validation before /verify", () => {
  it.each([
    ["an undecodable envelope", "bm90LWFuLWVudmVsb3Bl", "invalid_exact_stellar_payload_malformed"],
    [
      "two operations",
      envelope({ operations: "two" }),
      "invalid_exact_stellar_payload_wrong_operation",
    ],
    [
      "another asset",
      envelope({ asset: OTHER_ASSET }),
      "invalid_exact_stellar_payload_wrong_asset",
    ],
    [
      "another function",
      envelope({ functionName: "mint" }),
      "invalid_exact_stellar_payload_wrong_function_name",
    ],
    [
      "another payee",
      envelope({ to: PAYER.publicKey() }),
      "invalid_exact_stellar_payload_wrong_recipient",
    ],
    ["another amount", envelope({ amount: 1n }), "invalid_exact_stellar_payload_wrong_amount"],
    [
      "no auth entries",
      envelope({ auth: "none" }),
      "invalid_exact_stellar_payload_no_auth_entries",
    ],
    [
      "source-account credentials",
      envelope({ auth: "source-account" }),
      "invalid_exact_stellar_payload_unsupported_credential_type",
    ],
  ])("refuses %s with a 402 and never calls the facilitator", async (_name, transaction, reason) => {
    const { client, verify, settle } = realFacilitator();
    const onRejected = vi.fn();
    const outcome = await gateWith(client, { paymentPrevalidation: { onRejected } })(
      paid(transaction),
    );
    expect(outcome).toMatchObject({
      kind: "rejected",
      status: 402,
      code: "payment-invalid",
      upstreamReason: reason,
    });
    if (outcome.kind !== "rejected") return;
    // The fresh challenge lets the agent sign a correct payment at once.
    expect(
      decodePaymentRequiredHeader(outcome.headers?.[PAYMENT_REQUIRED_HEADER] ?? "").accepts,
    ).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith({ reason, resource: request.url, rejectedTotal: 1 });
  });

  it("sends a payment that passes every local check to /verify", async () => {
    const { client, verify } = realFacilitator();
    const outcome = await gateWith(client)(paid(envelope()));
    expect(outcome.kind).toBe("settled");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("leaves the facilitator authoritative: a locally valid payment it refuses is refused", async () => {
    const { client, settle } = realFacilitator("invalid");
    expect(await gateWith(client)(paid(envelope()))).toMatchObject({
      status: 402,
      code: "payment-invalid",
      upstreamReason: "invalid_exact_stellar_payload_simulation_failed",
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("refuses an oversized PAYMENT-SIGNATURE before decoding it", async () => {
    const { client, verify } = realFacilitator();
    const onRejected = vi.fn();
    const gate = gateWith(client, {
      paymentPrevalidation: { maxPaymentSignatureLength: 512, onRejected },
    });
    const outcome = await gate({
      ...request,
      headers: { [PAYMENT_SIGNATURE_HEADER]: "A".repeat(513) },
    });
    expect(outcome).toMatchObject({
      status: 402,
      code: "payment-invalid",
      upstreamReason: "payment_signature_too_large",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "payment_signature_too_large", rejectedTotal: 1 }),
    );
  });

  it("counts rejections across requests for the operator", async () => {
    const { client } = realFacilitator();
    const onRejected = vi.fn();
    const gate = gateWith(client, { paymentPrevalidation: { onRejected } });
    await gate(paid("bm9wZQ=="));
    await gate(paid(envelope({ amount: 2n })));
    expect(onRejected.mock.calls.map(([event]) => event.rejectedTotal)).toEqual([1, 2]);
  });

  it("lets the mock facilitator's non-XDR payments through only because the mock is configured", async () => {
    const mock = createMockFacilitator();
    expect(mock.acceptsMockPayments).toBe(true);
    expect((await gateWith(mock)(paid("mock-signed-auth-entry"))).kind).toBe("settled");

    const { client, verify } = realFacilitator();
    expect(await gateWith(client)(paid("mock-signed-auth-entry"))).toMatchObject({
      status: 402,
      upstreamReason: "invalid_exact_stellar_payload_malformed",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses an authorization behind the latest ledger when a ledger source is configured", async () => {
    const { client, verify } = realFacilitator();
    const latestLedger = createLatestLedgerSource({ getLatestLedger: async () => 2_000 });
    expect(
      await gateWith(client, { paymentPrevalidation: { latestLedger } })(
        paid(envelope({ expirationLedger: 1_000 })),
      ),
    ).toMatchObject({ status: 402, upstreamReason: "invalid_exact_stellar_signature_expired" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("skips the ledger check, and does not refuse, when the ledger is unavailable", async () => {
    const { client, verify } = realFacilitator();
    const onError = vi.fn();
    const latestLedger = createLatestLedgerSource({
      getLatestLedger: async () => {
        throw new Error("rpc down");
      },
      onError,
    });
    const outcome = await gateWith(client, { paymentPrevalidation: { latestLedger } })(
      paid(envelope({ expirationLedger: 1_000 })),
    );
    expect(outcome.kind).toBe("settled");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("replays a settled payment even after its authorization has expired", async () => {
    const { client, verify, settle } = realFacilitator();
    let ledger = 500;
    const latestLedger = createLatestLedgerSource({
      getLatestLedger: async () => ledger,
      ttlMs: 0,
    });
    const gate = gateWith(client, {
      cache: createInMemorySettlementCache(),
      paymentPrevalidation: { latestLedger },
    });
    const payment = paid(envelope({ expirationLedger: 1_000 }));
    expect((await gate(payment)).kind).toBe("settled");
    ledger = 2_000;
    expect(await gate(payment)).toMatchObject({ kind: "settled", replayed: true });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-positive header cap at construction", () => {
    expect(() =>
      gateWith(createMockFacilitator(), { paymentPrevalidation: { maxPaymentSignatureLength: 0 } }),
    ).toThrow(/maxPaymentSignatureLength/);
  });
});
