import {
  type BuildReceiptInput,
  buildReceipt,
  Ed25519Signer,
  signReceipt,
} from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import {
  createMemoryChannelStore,
  createMemoryMetricsStore,
  createMemoryPolicyStore,
  createMemoryReceiptStore,
} from "./stores.js";

const input: BuildReceiptInput = {
  payer: "GAGENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  payee: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  resource: "https://api.example.com/quotes/latest",
  model: "x402",
  settlement: { kind: "transaction", txHash: "abc123" },
  network: "testnet",
};

describe("memory receipt store", () => {
  it("stores once, reports a resubmission as a duplicate and a different body as a conflict", async () => {
    const signer = await Ed25519Signer.generate("k1");
    const receipt = await signReceipt(buildReceipt(input), signer);
    const store = createMemoryReceiptStore();

    expect(await store.put(receipt)).toBe("stored");
    // Same receipt, keys in a different order: still the same receipt.
    const reordered = JSON.parse(
      JSON.stringify({ signature: receipt.signature, receipt: receipt.receipt }),
    );
    expect(await store.put(reordered)).toBe("duplicate");

    const altered = await signReceipt({ ...receipt.receipt, amount: "1" }, signer);
    expect(await store.put(altered)).toBe("conflict");
    expect(await store.get(receipt.receipt.id)).toEqual(receipt);
  });

  it("returns copies, so a caller cannot change what is stored", async () => {
    const signer = await Ed25519Signer.generate("k1");
    const receipt = await signReceipt(buildReceipt(input), signer);
    const store = createMemoryReceiptStore();
    await store.put(receipt);
    const copy = await store.get(receipt.receipt.id);
    if (copy === undefined) throw new Error("expected the stored receipt");
    copy.receipt.amount = "999";
    expect((await store.get(receipt.receipt.id))?.receipt.amount).toBe("10000");
  });
});

describe("memory policy store", () => {
  it("appends versions and refuses a stale expected version", async () => {
    const store = createMemoryPolicyStore({ clock: () => Date.parse("2026-11-23T00:00:00Z") });
    const first = await store.append("agent-1", { policyVersion: 1 }, null);
    expect(first).toEqual({
      agentId: "agent-1",
      version: 1,
      policy: { policyVersion: 1 },
      createdAt: "2026-11-23T00:00:00.000Z",
    });
    expect(await store.append("agent-1", { policyVersion: 1 }, null)).toBe("version-conflict");
    const second = await store.append(
      "agent-1",
      { policyVersion: 1, budgets: { daily: "100" } },
      1,
    );
    expect(second).toMatchObject({ version: 2 });
    expect((await store.versions("agent-1")).map((entry) => entry.version)).toEqual([1, 2]);
    expect((await store.current("agent-1"))?.version).toBe(2);
    expect(await store.current("agent-2")).toBeUndefined();
  });
});

describe("memory metrics and channel stores", () => {
  it("summarise recorded metrics and keep channels", async () => {
    const metrics = createMemoryMetricsStore();
    await metrics.record([
      {
        payer: "GA",
        payee: "GB",
        model: "x402",
        amount: "5",
        asset: "USDC",
        latencyMs: 3,
        outcome: "settled",
        at: "2026-11-23T00:00:00.000Z",
      },
    ]);
    expect((await metrics.summarize()).count).toBe(1);

    const channels = createMemoryChannelStore();
    await expect(channels.check()).resolves.toBeUndefined();
    expect(await channels.getChannel("missing")).toBeUndefined();
  });
});
