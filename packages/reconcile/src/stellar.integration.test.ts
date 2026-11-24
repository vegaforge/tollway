import type { SignedReceipt } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createReconciler } from "./index.js";
import {
  createStellarChainReader,
  createStellarChannelStateReader,
  DEFAULT_STELLAR_RPC_URLS,
} from "./stellar.js";

/**
 * Opt-in integration tests: these reach a live testnet RPC server, so they
 * are skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_RECONCILE_INTEGRATION=true pnpm --filter @vegaforge/tollway-reconcile test
 *
 * TOLLWAY_RPC_URL overrides the RPC server (default: the public testnet one).
 *
 * The charge test needs a real settled payment inside the server's retention
 * window: set TOLLWAY_TEST_CHARGE_TX to its hash and TOLLWAY_TEST_PAYER,
 * TOLLWAY_TEST_PAY_TO, TOLLWAY_TEST_AMOUNT and TOLLWAY_TEST_ASSET to what it
 * paid. The channel test needs a deployed one-way-channel contract: set
 * TOLLWAY_TEST_CHANNEL to its address. Opening one needs a funded account and
 * the contract WASM, which belongs to the channel tooling, not these tests.
 */

const RUN = process.env.TOLLWAY_RECONCILE_INTEGRATION === "true";
const RPC_URL = process.env.TOLLWAY_RPC_URL ?? DEFAULT_STELLAR_RPC_URLS.testnet;

describe.skipIf(!RUN)("Stellar readers (integration)", () => {
  const chainTx = process.env.TOLLWAY_TEST_CHARGE_TX;
  it.skipIf(!chainTx)("confirms a real testnet charge receipt", async () => {
    const receipt: SignedReceipt = {
      receipt: {
        version: 1,
        id: "integration",
        model: "x402",
        network: "testnet",
        payer: process.env.TOLLWAY_TEST_PAYER ?? "",
        payee: process.env.TOLLWAY_TEST_PAY_TO ?? "",
        amount: process.env.TOLLWAY_TEST_AMOUNT ?? "",
        asset: process.env.TOLLWAY_TEST_ASSET ?? "",
        resource: "https://example.com/integration",
        settlement: { kind: "transaction", txHash: chainTx ?? "" },
        issuedAt: new Date().toISOString(),
      },
      signature: { keyId: "integration", algorithm: "ed25519", value: "c2ln" },
    };
    const reconciler = createReconciler({
      chain: createStellarChainReader({ rpc: { testnet: RPC_URL } }),
    });
    const result = await reconciler.reconcileCharge(receipt);
    expect(result).toMatchObject({ status: "ok" });
  });

  it("reports a hash the server has never seen as tx-not-found", async () => {
    const reconciler = createReconciler({
      chain: createStellarChainReader({ rpc: { testnet: RPC_URL } }),
    });
    const result = await reconciler.reconcileCharge({
      receipt: {
        version: 1,
        id: "integration-missing",
        model: "x402",
        network: "testnet",
        payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        payee: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amount: "1",
        asset: "native",
        resource: "https://example.com/integration",
        settlement: { kind: "transaction", txHash: "0".repeat(64) },
        // A minute ago: inside the retention window, and already closed.
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      signature: { keyId: "integration", algorithm: "ed25519", value: "c2ln" },
    });
    expect(result.status === "drift" ? result.drift.map((d) => d.kind) : []).toEqual([
      "tx-not-found",
    ]);
  });

  const channel = process.env.TOLLWAY_TEST_CHANNEL;
  it.skipIf(!channel)("reads a deployed channel contract's state", async () => {
    const reader = createStellarChannelStateReader({ rpcUrl: { testnet: RPC_URL } });
    const state = await reader.getChannelState(channel ?? "", "testnet");
    expect(state.token).toMatch(/^C[A-Z2-7]{55}$/);
    expect(state.balance).toMatch(/^[0-9]+$/);
  });
});
