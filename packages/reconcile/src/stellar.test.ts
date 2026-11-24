import {
  Address,
  Asset,
  Keypair,
  Networks,
  nativeToScVal,
  type rpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type { SignedReceipt } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { STELLAR_NETWORK_PASSPHRASE } from "./chain.js";
import { createReconciler, type ReconciliationResult } from "./index.js";
import {
  ChainReadError,
  createStellarChainReader,
  createStellarChannelStateReader,
  decodeTransferEvent,
  type GetChannelState,
  openChannelSnapshot,
  resolveAssetContractId,
  type StellarTransactionRpc,
} from "./stellar.js";

const PAYER = Keypair.random().publicKey();
const PAYEE = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = new Asset("USDC", ISSUER).contractId(Networks.TESTNET);
const EURC = new Asset("EURC", ISSUER).contractId(Networks.TESTNET);
const TX_HASH = "b".repeat(64);
const RECEIPT_TIME = "2026-11-24T12:00:00.000Z";
const RECEIPT_SECONDS = Date.parse(RECEIPT_TIME) / 1000;

// ── resolveAssetContractId ───────────────────────────────────────────────────

describe("resolveAssetContractId", () => {
  // Published Stellar Asset Contract addresses. @stellar/mpp 0.7.1's
  // USDC_SAC_MAINNET and XLM_SAC_MAINNET constants do not match these (the
  // first is truncated), so the expected values come from the networks.
  it.each([
    ["native", "testnet", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"],
    ["native", "mainnet", "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"],
    [
      "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "testnet",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ],
    [
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "mainnet",
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    ],
  ] as const)("maps %s on %s to its Stellar Asset Contract", (asset, network, contract) => {
    expect(resolveAssetContractId(asset, network)).toBe(contract);
  });

  it("gives a classic asset a different contract on each network", () => {
    const asset = `USDC:${ISSUER}`;
    expect(resolveAssetContractId(asset, "testnet")).not.toBe(
      resolveAssetContractId(asset, "mainnet"),
    );
  });

  it("returns a contract address unchanged", () => {
    expect(resolveAssetContractId(USDC, "mainnet")).toBe(USDC);
  });

  it.each(["USDC", "XLM", "USDC:not-an-issuer", ""])("rejects %j", (asset) => {
    expect(() => resolveAssetContractId(asset, "testnet")).toThrow(TypeError);
  });
});

// ── XDR fixtures ─────────────────────────────────────────────────────────────

type EventSpec = {
  contract?: string;
  name?: string;
  from?: string;
  to?: string;
  amount?: bigint;
  /** "i128" before CAP-67, "map" after it (with to_muxed_id). */
  data?: "i128" | "map";
  /** A Stellar Asset Contract adds the asset name as a fourth topic. */
  sacAsset?: string;
  type?: "contract" | "system";
};

/** Builds an event and round-trips it through base64, as RPC delivers it. */
function event(spec: EventSpec = {}): xdr.ContractEvent {
  const amount = nativeToScVal(spec.amount ?? 1000n, { type: "i128" });
  const data =
    spec.data === "map"
      ? xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: amount }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("to_muxed_id"),
            val: nativeToScVal(7n, { type: "u64" }),
          }),
        ])
      : amount;
  const topics = [
    xdr.ScVal.scvSymbol(spec.name ?? "transfer"),
    Address.fromString(spec.from ?? PAYER).toScVal(),
    Address.fromString(spec.to ?? PAYEE).toScVal(),
    ...(spec.sacAsset !== undefined ? [xdr.ScVal.scvString(spec.sacAsset)] : []),
  ];
  const built = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(spec.contract ?? USDC) as unknown as xdr.ContractId,
    type:
      spec.type === "system" ? xdr.ContractEventType.system() : xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  });
  return xdr.ContractEvent.fromXDR(built.toXDR("base64"), "base64");
}

const RETENTION = {
  txHash: TX_HASH,
  latestLedger: 2000,
  latestLedgerCloseTime: RECEIPT_SECONDS + 3600,
  oldestLedger: 1000,
  oldestLedgerCloseTime: RECEIPT_SECONDS - 7 * 86_400,
};

function found(
  events: xdr.ContractEvent[][],
  overrides: { status?: "SUCCESS" | "FAILED"; feeBump?: boolean } = {},
) {
  return {
    status: overrides.status ?? "SUCCESS",
    ...RETENTION,
    ledger: 1999,
    createdAt: RECEIPT_SECONDS,
    applicationOrder: 1,
    feeBump: overrides.feeBump ?? false,
    events: { transactionEventsXdr: [], contractEventsXdr: events },
  };
}

function fakeRpc(
  tx: unknown,
  passphrase: string = Networks.TESTNET,
): StellarTransactionRpc & { getTransaction: ReturnType<typeof vi.fn> } {
  return {
    getTransaction: vi.fn(async () => {
      if (tx instanceof Error) throw tx;
      return tx as rpc.Api.GetTransactionResponse;
    }),
    getNetwork: vi.fn(async () => ({ passphrase, protocolVersion: "23" })),
  };
}

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
      issuedAt: RECEIPT_TIME,
      ...overrides,
    } as SignedReceipt["receipt"],
    signature: { keyId: "key-1", algorithm: "ed25519", value: "c2lnbmF0dXJl" },
  };
}

async function reconcile(tx: unknown, r = receipt(), passphrase?: string) {
  const chain = createStellarChainReader({ rpc: { testnet: fakeRpc(tx, passphrase) } });
  return createReconciler({ chain }).reconcileCharge(r);
}

const kinds = (result: ReconciliationResult) =>
  result.status === "drift" ? result.drift.map((d) => d.kind) : [];

// ── decodeTransferEvent ──────────────────────────────────────────────────────

describe("decodeTransferEvent", () => {
  const expected = { contract: USDC, from: PAYER, to: PAYEE, amount: "1000" };

  it("decodes a SEP-41 transfer with an i128 amount", () => {
    expect(decodeTransferEvent(event())).toEqual(expected);
  });

  it("decodes a Stellar Asset Contract transfer with the asset topic", () => {
    expect(decodeTransferEvent(event({ sacAsset: `USDC:${ISSUER}` }))).toEqual(expected);
  });

  it("decodes the CAP-67 map data shape", () => {
    expect(decodeTransferEvent(event({ data: "map", sacAsset: "native" }))).toEqual(expected);
  });

  it("keeps amounts beyond Number precision exact", () => {
    expect(decodeTransferEvent(event({ amount: 9007199254740993n }))?.amount).toBe(
      "9007199254740993",
    );
  });

  it("ignores an event with another name", () => {
    expect(decodeTransferEvent(event({ name: "mint" }))).toBeUndefined();
  });

  it("ignores a system event", () => {
    expect(decodeTransferEvent(event({ type: "system" }))).toBeUndefined();
  });

  it("ignores a negative amount", () => {
    expect(decodeTransferEvent(event({ amount: -1n }))).toBeUndefined();
  });
});

// ── createStellarChainReader through reconcileCharge ─────────────────────────

describe("createStellarChainReader", () => {
  it("confirms a matching transfer", async () => {
    const result = await reconcile(found([[event()]]));
    expect(result.status).toBe("ok");
  });

  it("confirms the CAP-67 data shape", async () => {
    const result = await reconcile(found([[event({ data: "map", sacAsset: `USDC:${ISSUER}` })]]));
    expect(result.status).toBe("ok");
  });

  it("confirms a fee-bumped, facilitator-sponsored transaction", async () => {
    // The envelope's fee source is the facilitator, not the payer; only the
    // transfer event is compared.
    const result = await reconcile(found([[event()]], { feeBump: true }));
    expect(result.status).toBe("ok");
  });

  it("finds the payment across operations and among other events", async () => {
    const result = await reconcile(
      found([[event({ name: "approve" })], [event({ from: STRANGER, amount: 5n }), event()]]),
    );
    expect(result.status).toBe("ok");
  });

  it("confirms a receipt whose asset is CODE:ISSUER", async () => {
    const result = await reconcile(found([[event()]]), receipt({ asset: `USDC:${ISSUER}` }));
    expect(result.status).toBe("ok");
  });

  it.each([
    ["amount-mismatch", { amount: 999n }],
    ["payee-mismatch", { to: STRANGER }],
    ["payer-mismatch", { from: STRANGER }],
    ["asset-mismatch", { contract: EURC }],
  ] as const)("reports %s", async (kind, spec) => {
    const result = await reconcile(found([[event(spec)]]));
    expect(kinds(result)).toEqual([kind]);
  });

  it("reports tx-failed", async () => {
    const result = await reconcile(found([], { status: "FAILED" }));
    expect(kinds(result)).toEqual(["tx-failed"]);
  });

  it("reports transfer-missing when no transfer event was emitted", async () => {
    const result = await reconcile(found([[event({ name: "mint" })]]));
    expect(kinds(result)).toEqual(["transfer-missing"]);
  });

  it("reports network-mismatch when the server is on another network", async () => {
    const result = await reconcile(found([[event()]]), receipt(), Networks.PUBLIC);
    expect(kinds(result)).toEqual(["network-mismatch"]);
  });

  it("reports tx-not-found inside the retention window", async () => {
    const result = await reconcile({ status: "NOT_FOUND", ...RETENTION });
    expect(kinds(result)).toEqual(["tx-not-found"]);
  });

  it("is unverifiable outside the retention window", async () => {
    const result = await reconcile(
      { status: "NOT_FOUND", ...RETENTION },
      receipt({ issuedAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(result.status).toBe("unverifiable");
  });

  it("accepts close times given as numeric strings, as raw RPC sends them", async () => {
    const result = await reconcile({
      status: "NOT_FOUND",
      ...RETENTION,
      latestLedgerCloseTime: String(RETENTION.latestLedgerCloseTime),
      oldestLedgerCloseTime: String(RETENTION.oldestLedgerCloseTime),
    });
    expect(kinds(result)).toEqual(["tx-not-found"]);
  });

  it("is retryable when getTransaction rejects", async () => {
    const result = await reconcile(new Error("503 Service Unavailable"));
    expect(result.status).toBe("retryable");
    if (result.status === "retryable") expect(result.reason).toContain("503");
  });

  it("is retryable when the response is malformed", async () => {
    const result = await reconcile({ status: "SUCCESS", ...RETENTION, events: "nope" });
    expect(result.status).toBe("retryable");
    if (result.status === "retryable") expect(result.reason).toContain("malformed");
  });

  it("throws ChainReadError for a malformed response", async () => {
    const chain = createStellarChainReader({ rpc: { testnet: fakeRpc({ status: "WEIRD" }) } });
    await expect(chain.getTransaction(TX_HASH, "testnet")).rejects.toBeInstanceOf(ChainReadError);
  });

  it("asks for the network again after a failed lookup", async () => {
    const server = fakeRpc(found([[event()]]));
    server.getNetwork = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ passphrase: Networks.TESTNET, protocolVersion: "23" });
    const chain = createStellarChainReader({ rpc: { testnet: server } });
    await expect(chain.getTransaction(TX_HASH, "testnet")).rejects.toThrow("timeout");
    const tx = await chain.getTransaction(TX_HASH, "testnet");
    expect(tx.networkPassphrase).toBe(STELLAR_NETWORK_PASSPHRASE.testnet);
    await chain.getTransaction(TX_HASH, "testnet");
    expect(server.getNetwork).toHaveBeenCalledTimes(2);
  });

  it("uses the server configured for the receipt's network", async () => {
    const testnet = fakeRpc(found([[event()]]));
    const mainnet = fakeRpc(found([[event()]]), Networks.PUBLIC);
    const chain = createStellarChainReader({ rpc: { testnet, mainnet } });
    await chain.getTransaction(TX_HASH, "mainnet");
    expect(mainnet.getTransaction).toHaveBeenCalledWith(TX_HASH);
    expect(testnet.getTransaction).not.toHaveBeenCalled();
  });
});

// ── createStellarChannelStateReader ──────────────────────────────────────────

describe("createStellarChannelStateReader", () => {
  const CHANNEL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const mppState = {
    balance: 10000n,
    refundWaitingPeriod: 100,
    token: USDC,
    from: PAYER,
    to: PAYEE,
    closeEffectiveAtLedger: null,
    currentLedger: 500,
  };

  it("maps getChannelState into the Tollway shape and passes the network and RPC URL", async () => {
    const getChannelState = vi.fn(async () => mppState) as unknown as GetChannelState;
    const reader = createStellarChannelStateReader({
      getChannelState,
      rpcUrl: { mainnet: "https://rpc.example.com" },
      simulationTimeoutMs: 2500,
    });
    const state = await reader.getChannelState(CHANNEL, "mainnet");
    expect(state).toEqual({ ...mppState, balance: "10000" });
    expect(getChannelState).toHaveBeenCalledWith({
      channel: CHANNEL,
      network: "stellar:pubnet",
      rpcUrl: "https://rpc.example.com",
      simulationTimeoutMs: 2500,
    });
  });

  it("throws ChainReadError for a malformed state", async () => {
    const getChannelState = vi.fn(async () => ({
      ...mppState,
      balance: 10,
    })) as unknown as GetChannelState;
    const reader = createStellarChannelStateReader({ getChannelState });
    await expect(reader.getChannelState(CHANNEL, "testnet")).rejects.toBeInstanceOf(ChainReadError);
  });

  it("makes a timed-out read retryable through checkOpenChannel", async () => {
    const getChannelState = vi.fn(async () => {
      throw new Error(`simulate balance on channel ${CHANNEL} timed out after 10000ms`);
    }) as unknown as GetChannelState;
    const reconciler = createReconciler({
      channels: createStellarChannelStateReader({ getChannelState }),
    });
    const result = await reconciler.checkOpenChannel(
      openChannelSnapshot({
        id: CHANNEL,
        network: "testnet",
        status: "open",
        counterparty: PAYEE,
        asset: `USDC:${ISSUER}`,
        deposit: "10000",
        committed: "0",
      }),
    );
    expect(result.status).toBe("retryable");
  });

  it("feeds a live check end to end", async () => {
    const getChannelState = vi.fn(async () => ({
      ...mppState,
      closeEffectiveAtLedger: 600,
    })) as unknown as GetChannelState;
    const reconciler = createReconciler({
      channels: createStellarChannelStateReader({ getChannelState }),
    });
    const result = await reconciler.checkOpenChannel(
      openChannelSnapshot(
        {
          id: CHANNEL,
          network: "testnet",
          status: "open",
          counterparty: PAYEE,
          asset: `USDC:${ISSUER}`,
          deposit: "10000",
          committed: "0",
        },
        { funder: PAYER },
      ),
    );
    expect(kinds(result)).toEqual(["closed-on-chain"]);
  });
});

describe("openChannelSnapshot", () => {
  it("resolves the asset to its token contract and keeps the funder", () => {
    expect(
      openChannelSnapshot(
        {
          id: "C-ch",
          network: "testnet",
          status: "open",
          counterparty: PAYEE,
          asset: `USDC:${ISSUER}`,
          deposit: "1",
          committed: "0",
        },
        { funder: PAYER },
      ),
    ).toEqual({
      channelId: "C-ch",
      network: "testnet",
      status: "open",
      counterparty: PAYEE,
      tokenContract: USDC,
      deposit: "1",
      committed: "0",
      funder: PAYER,
    });
  });
});
