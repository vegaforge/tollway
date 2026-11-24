import type { SignedReceipt, StellarNetwork } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import {
  type ChainReader,
  type ChainTransaction,
  type ChainTransfer,
  STELLAR_NETWORK_PASSPHRASE,
} from "./chain.js";
import { confirmCharge } from "./charge.js";
import { createReconciler, type ReconciliationResult } from "./index.js";

const PAYER = `G${"A".repeat(55)}`;
const PAYEE = `G${"B".repeat(55)}`;
const OTHER = `G${"C".repeat(55)}`;
const USDC = `C${"D".repeat(55)}`;
const EURC = `C${"E".repeat(55)}`;
const TX_HASH = "a".repeat(64);

function receipt(overrides: Partial<SignedReceipt["receipt"]> = {}): SignedReceipt {
  return {
    receipt: {
      version: 1,
      id: "rcpt-1",
      model: "x402",
      network: "testnet",
      payer: PAYER,
      payee: PAYEE,
      amount: "1000",
      asset: USDC,
      resource: "https://api.example.com/resource",
      settlement: { kind: "transaction", txHash: TX_HASH },
      issuedAt: "2026-11-24T12:00:00.000Z",
      ...overrides,
    } as SignedReceipt["receipt"],
    signature: { keyId: "key-1", algorithm: "ed25519", value: "c2lnbmF0dXJl" },
  };
}

const RETENTION = {
  hash: TX_HASH,
  networkPassphrase: STELLAR_NETWORK_PASSPHRASE.testnet,
  latestLedger: 2000,
  latestLedgerCloseTime: "2026-11-24T13:00:00.000Z",
  oldestLedger: 1000,
  oldestLedgerCloseTime: "2026-11-17T13:00:00.000Z",
};

function payment(overrides: Partial<ChainTransfer> = {}): ChainTransfer {
  return { contract: USDC, from: PAYER, to: PAYEE, amount: "1000", ...overrides };
}

function success(transfers: ChainTransfer[], overrides: Partial<ChainTransaction> = {}) {
  return {
    status: "SUCCESS",
    ...RETENTION,
    ledger: 1999,
    createdAt: "2026-11-24T12:00:00.000Z",
    feeBump: false,
    transfers,
    ...overrides,
  } as ChainTransaction;
}

function reader(tx: ChainTransaction | Error | unknown): ChainReader {
  return {
    getTransaction: vi.fn(async (_hash: string, _network: StellarNetwork) => {
      if (tx instanceof Error) throw tx;
      return tx as ChainTransaction;
    }),
    assetContractId: (asset: string) => {
      if (/^C[A-Z2-7]{55}$/.test(asset)) return asset;
      throw new TypeError(`unsupported asset ${asset}`);
    },
  };
}

function kinds(result: ReconciliationResult): string[] {
  return result.status === "drift" ? result.drift.map((d) => d.kind) : [];
}

describe("confirmCharge", () => {
  const body = { ...receipt().receipt, txHash: TX_HASH };

  it("confirms a successful transaction with the matching transfer", () => {
    expect(confirmCharge(body, success([payment()]), USDC)).toEqual({ status: "confirmed" });
  });

  it("finds the payment among unrelated transfers", () => {
    const tx = success([payment({ from: OTHER, to: OTHER, amount: "5" }), payment()]);
    expect(confirmCharge(body, tx, USDC)).toEqual({ status: "confirmed" });
  });

  it("compares amounts as integers", () => {
    expect(confirmCharge({ ...body, amount: "01000" }, success([payment()]), USDC)).toEqual({
      status: "confirmed",
    });
  });

  it("confirms a fee-bumped transaction whose source is not the payer", () => {
    // The facilitator's fee-bump envelope pays the fee; the payer appears
    // only in the transfer event, which is all confirmation looks at.
    expect(confirmCharge(body, success([payment()], { feeBump: true }), USDC)).toEqual({
      status: "confirmed",
    });
  });

  it("reports tx-failed with the ledger", () => {
    const result = confirmCharge(body, success([], { status: "FAILED", ledger: 1500 }), USDC);
    expect(result).toEqual({
      status: "drift",
      drift: [{ kind: "tx-failed", detail: expect.stringContaining("ledger 1500") }],
    });
  });

  it("reports transfer-missing when a successful transaction moved no token", () => {
    const result = confirmCharge(body, success([]), USDC);
    expect(result.status === "drift" ? result.drift.map((d) => d.kind) : []).toEqual([
      "transfer-missing",
    ]);
  });

  it.each([
    ["amount-mismatch", { amount: "999" }, "expected amount 1000, got 999"],
    ["payer-mismatch", { from: OTHER }, `expected payer ${PAYER}, got ${OTHER}`],
    ["payee-mismatch", { to: OTHER }, `expected payee ${PAYEE}, got ${OTHER}`],
    ["asset-mismatch", { contract: EURC }, `expected token contract ${USDC}, got ${EURC}`],
  ] as const)("reports %s naming the expected and actual value", (kind, change, detail) => {
    const result = confirmCharge(body, success([payment(change)]), USDC);
    expect(result).toEqual({
      status: "drift",
      drift: [{ kind, detail: expect.stringContaining(detail) }],
    });
  });

  it("reports every field the closest transfer gets wrong", () => {
    const result = confirmCharge(body, success([payment({ amount: "1", to: OTHER })]), USDC);
    expect(result.status === "drift" ? result.drift.map((d) => d.kind) : []).toEqual([
      "payee-mismatch",
      "amount-mismatch",
    ]);
  });

  it("reports network-mismatch when the RPC server is on another network", () => {
    const tx = success([payment()], { networkPassphrase: STELLAR_NETWORK_PASSPHRASE.mainnet });
    const result = confirmCharge(body, tx, USDC);
    expect(result).toEqual({
      status: "drift",
      drift: [{ kind: "network-mismatch", detail: expect.stringContaining("Public Global") }],
    });
  });

  it("reports tx-not-found when the receipt falls inside the retention window", () => {
    const result = confirmCharge(body, { status: "NOT_FOUND", ...RETENTION }, USDC);
    expect(result).toEqual({
      status: "drift",
      drift: [{ kind: "tx-not-found", detail: expect.stringContaining("ledgers 1000 to 2000") }],
    });
  });

  it("is unverifiable, not drift, when the receipt is older than the retention window", () => {
    const old = { ...body, issuedAt: "2026-11-01T00:00:00.000Z" };
    const result = confirmCharge(old, { status: "NOT_FOUND", ...RETENTION }, USDC);
    expect(result.status).toBe("unverifiable");
  });

  it("is retryable when the RPC server has not reached the receipt yet", () => {
    const fresh = { ...body, issuedAt: "2026-11-24T14:00:00.000Z" };
    const result = confirmCharge(fresh, { status: "NOT_FOUND", ...RETENTION }, USDC);
    expect(result.status).toBe("retryable");
  });
});

describe("reconcileCharge with a ChainReader", () => {
  it("is ok when the chain confirms the receipt", async () => {
    const chain = reader(success([payment()]));
    const result = await createReconciler({ chain }).reconcileCharge(receipt());
    expect(result).toEqual({
      status: "ok",
      ok: true,
      subject: { kind: "transaction", txHash: TX_HASH, network: "testnet" },
    });
    expect(chain.getTransaction).toHaveBeenCalledWith(TX_HASH, "testnet");
  });

  it("returns drift with the subject naming the transaction", async () => {
    const result = await createReconciler({
      chain: reader(success([payment({ amount: "1" })])),
    }).reconcileCharge(receipt());
    expect(result.status).toBe("drift");
    expect(result.subject).toEqual({ kind: "transaction", txHash: TX_HASH, network: "testnet" });
    expect(kinds(result)).toEqual(["amount-mismatch"]);
  });

  it("is retryable, never drift, when the reader throws", async () => {
    const result = await createReconciler({
      chain: reader(new Error("ECONNRESET")),
    }).reconcileCharge(receipt());
    expect(result).toEqual({
      status: "retryable",
      ok: false,
      subject: { kind: "transaction", txHash: TX_HASH, network: "testnet" },
      reason: expect.stringContaining("ECONNRESET"),
    });
  });

  it("is retryable when the reader returns a malformed transaction", async () => {
    const result = await createReconciler({
      chain: reader({ status: "SUCCESS", hash: TX_HASH }),
    }).reconcileCharge(receipt());
    expect(result.status).toBe("retryable");
    if (result.status === "retryable") expect(result.reason).toContain("malformed");
  });

  it("is unverifiable when the transaction is older than the RPC retention window", async () => {
    const result = await createReconciler({
      chain: reader({ status: "NOT_FOUND", ...RETENTION }),
    }).reconcileCharge(receipt({ issuedAt: "2026-01-01T00:00:00.000Z" }));
    expect(result.status).toBe("unverifiable");
  });

  it("flags an asset with no token contract as malformed-record without a lookup", async () => {
    const chain = reader(success([payment()]));
    const result = await createReconciler({ chain }).reconcileCharge(
      receipt({ asset: "not an asset" }),
    );
    expect(kinds(result)).toEqual(["malformed-record"]);
    expect(chain.getTransaction).not.toHaveBeenCalled();
  });

  it("does not read the chain for a structurally invalid receipt", async () => {
    const chain = reader(success([payment()]));
    const result = await createReconciler({ chain }).reconcileCharge(receipt({ amount: "1.5" }));
    expect(kinds(result)).toEqual(["malformed-record"]);
    expect(chain.getTransaction).not.toHaveBeenCalled();
  });

  it("does not read the chain for a channel receipt", async () => {
    const chain = reader(success([payment()]));
    const result = await createReconciler({ chain }).reconcileCharge(
      receipt({
        model: "mpp-channel",
        settlement: { kind: "channel-commitment", channelId: "ch-9", sequence: 3 },
      } as Partial<SignedReceipt["receipt"]>),
    );
    expect(result.subject).toEqual({ kind: "channel", channelId: "ch-9" });
    expect(chain.getTransaction).not.toHaveBeenCalled();
  });

  it("lets suppress drop a drift item, given the subject", async () => {
    const suppress = vi.fn(() => true);
    const result = await createReconciler({
      chain: reader(success([payment({ amount: "1" })])),
      suppress,
    }).reconcileCharge(receipt());
    expect(result.status).toBe("ok");
    expect(suppress).toHaveBeenCalledWith(expect.objectContaining({ kind: "amount-mismatch" }), {
      kind: "transaction",
      txHash: TX_HASH,
      network: "testnet",
    });
  });

  it("checks structure only when no reader is configured", async () => {
    const result = await createReconciler().reconcileCharge(receipt());
    expect(result.status).toBe("ok");
  });
});
