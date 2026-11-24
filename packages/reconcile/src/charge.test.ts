import { Address, Asset, Keypair, Networks, nativeToScVal, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import type { SignedReceipt } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { type ChargeRpcSource, resolveAssetContractId } from "./charge.js";
import { createReconciler } from "./index.js";

const PAYER = Keypair.random().publicKey();
const PAYEE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC_CONTRACT = new Asset("USDC", ISSUER).contractId(Networks.TESTNET);
const TX_HASH = "a".repeat(64);

function makeReceipt(overrides?: Partial<SignedReceipt["receipt"]>): SignedReceipt {
  return {
    receipt: {
      version: 1,
      id: "rcpt-charge-1",
      model: "x402",
      network: "testnet",
      payer: PAYER,
      payee: PAYEE,
      amount: "1000",
      asset: USDC_CONTRACT,
      resource: "https://api.example.com/resource",
      settlement: {
        kind: "transaction",
        txHash: TX_HASH,
      },
      issuedAt: "2026-11-24T00:00:00.000Z",
      ...overrides,
    },
    signature: "sig-placeholder",
  };
}

function makeTransferEvent(opts: {
  contractId: string;
  from: string;
  to: string;
  amount: bigint;
}): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Buffer.from(StrKey.decodeContract(opts.contractId)),
    type: xdr.ContractEventType.contract(),
    body: xdr.ContractEventBody.v0(
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("transfer", { type: "symbol" }),
          Address.fromString(opts.from).toScVal(),
          Address.fromString(opts.to).toScVal(),
        ],
        data: nativeToScVal(opts.amount, { type: "i128" }),
      }),
    ),
  });
}

function makeSuccessTx(events: xdr.ContractEvent[][]): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    latestLedger: 1000,
    latestLedgerCloseTime: 1700000000,
    oldestLedger: 500,
    oldestLedgerCloseTime: 1699990000,
    ledger: 999,
    createdAt: 1699999990,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: {} as xdr.TransactionEnvelope,
    resultXdr: {} as xdr.TransactionResult,
    resultMetaXdr: {} as xdr.TransactionMeta,
    events: {
      diagnosticEventsXdr: [],
      transactionEventsXdr: [],
      contractEventsXdr: events,
    },
  };
}

describe("resolveAssetContractId", () => {
  it("returns C... contract addresses unchanged", () => {
    expect(resolveAssetContractId(USDC_CONTRACT, "testnet")).toBe(USDC_CONTRACT);
  });

  it("maps CODE:ISSUER to its Stellar Asset Contract address", () => {
    expect(resolveAssetContractId(`USDC:${ISSUER}`, "testnet")).toBe(USDC_CONTRACT);
  });

  it("maps native and XLM to the native SAC address", () => {
    const expected = Asset.native().contractId(Networks.TESTNET);
    expect(resolveAssetContractId("native", "testnet")).toBe(expected);
    expect(resolveAssetContractId("XLM", "testnet")).toBe(expected);
  });

  it("throws TypeError for unsupported asset formats", () => {
    expect(() => resolveAssetContractId("invalid-asset", "testnet")).toThrow(TypeError);
  });
});

describe("reconcileCharge on-chain confirmation", () => {
  it("returns ok when transaction succeeded with matching SEP-41 transfer", async () => {
    const rpcSource: ChargeRpcSource = {
      getNetwork: vi.fn().mockResolvedValue({ passphrase: Networks.TESTNET }),
      getTransaction: vi.fn().mockResolvedValue(
        makeSuccessTx([[makeTransferEvent({ contractId: USDC_CONTRACT, from: PAYER, to: PAYEE, amount: 1000n })]]),
      ),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(makeReceipt());
    expect(res).toEqual({ ok: true, channelId: TX_HASH });
    expect(rpcSource.getTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it("resolves CODE:ISSUER asset on mpp-charge receipts", async () => {
    const rpcSource: ChargeRpcSource = {
      getTransaction: vi.fn().mockResolvedValue(
        makeSuccessTx([[makeTransferEvent({ contractId: USDC_CONTRACT, from: PAYER, to: PAYEE, amount: 2500n })]]),
      ),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(
      makeReceipt({ model: "mpp-charge", asset: `USDC:${ISSUER}`, amount: "2500" }),
    );
    expect(res).toEqual({ ok: true, channelId: TX_HASH });
  });

  it("flags transaction-not-found when RPC returns NOT_FOUND", async () => {
    const rpcSource: ChargeRpcSource = {
      getTransaction: vi.fn().mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1000,
        latestLedgerCloseTime: 1700000000,
        oldestLedger: 500,
        oldestLedgerCloseTime: 1699990000,
      }),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(makeReceipt());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toEqual(["transaction-not-found"]);
    }
  });

  it("flags transaction-failed when RPC returns FAILED", async () => {
    const rpcSource: ChargeRpcSource = {
      getTransaction: vi.fn().mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        latestLedger: 1000,
        latestLedgerCloseTime: 1700000000,
        oldestLedger: 500,
        oldestLedgerCloseTime: 1699990000,
        ledger: 999,
        createdAt: 1699999990,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as xdr.TransactionEnvelope,
        resultXdr: {} as xdr.TransactionResult,
        resultMetaXdr: {} as xdr.TransactionMeta,
      }),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(makeReceipt());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toEqual(["transaction-failed"]);
    }
  });

  it("flags network-mismatch when RPC network passphrase differs", async () => {
    const rpcSource: ChargeRpcSource = {
      getNetwork: vi.fn().mockResolvedValue({ passphrase: Networks.PUBLIC }),
      getTransaction: vi.fn(),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(makeReceipt({ network: "testnet" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toEqual(["network-mismatch"]);
    }
    expect(rpcSource.getTransaction).not.toHaveBeenCalled();
  });

  it("flags transfer-mismatch when amount, payer, payee, or token does not match", async () => {
    const rpcSource: ChargeRpcSource = {
      getTransaction: vi.fn().mockResolvedValue(
        makeSuccessTx([[makeTransferEvent({ contractId: USDC_CONTRACT, from: PAYER, to: PAYEE, amount: 999n })]]),
      ),
    };
    const reconciler = createReconciler({ rpc: rpcSource });

    const res = await reconciler.reconcileCharge(makeReceipt({ amount: "1000" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toEqual(["transfer-mismatch"]);
    }
  });
});
