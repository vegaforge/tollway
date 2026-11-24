import {
  type BuildReceiptInput,
  buildReceipt,
  Ed25519Signer,
  signReceipt,
} from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import {
  createMemoryAuditStore,
  createMemoryChannelStore,
  createMemoryMetricsStore,
  createMemoryPolicyStore,
  createMemoryReceiptStore,
  createMemoryStoresWithAdmin,
} from "./stores.js";
import type { TenantScope } from "./tenancy.js";

const TENANT_A: TenantScope = { orgId: "org-a", projectId: "proj-1" };
const TENANT_B: TenantScope = { orgId: "org-a", projectId: "proj-2" };

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
  it("stores once per tenant, reports a resubmission as duplicate, and isolates collisions across projects", async () => {
    const signer = await Ed25519Signer.generate("k1");
    const receipt = await signReceipt(buildReceipt(input), signer);
    const store = createMemoryReceiptStore();

    expect(await store.put(TENANT_A, receipt)).toBe("stored");
    // Same receipt, keys in a different order: still the same receipt.
    const reordered = JSON.parse(
      JSON.stringify({ signature: receipt.signature, receipt: receipt.receipt }),
    );
    expect(await store.put(TENANT_A, reordered)).toBe("duplicate");

    const altered = await signReceipt({ ...receipt.receipt, amount: "1" }, signer);
    expect(await store.put(TENANT_A, altered)).toBe("conflict");
    expect(await store.get(TENANT_A, receipt.receipt.id)).toEqual({
      ...TENANT_A,
      receipt,
    });

    // Another project may store a different receipt under the exact same id.
    expect(await store.get(TENANT_B, receipt.receipt.id)).toBeUndefined();
    expect(await store.put(TENANT_B, altered)).toBe("stored");
    expect((await store.get(TENANT_B, receipt.receipt.id))?.receipt.receipt.amount).toBe("1");
    expect((await store.get(TENANT_A, receipt.receipt.id))?.receipt.receipt.amount).toBe("10000");
  });

  it("returns copies, so a caller cannot change what is stored", async () => {
    const signer = await Ed25519Signer.generate("k1");
    const receipt = await signReceipt(buildReceipt(input), signer);
    const store = createMemoryReceiptStore();
    await store.put(TENANT_A, receipt);
    const copy = await store.get(TENANT_A, receipt.receipt.id);
    if (copy === undefined) throw new Error("expected the stored receipt");
    copy.receipt.receipt.amount = "999";
    expect((await store.get(TENANT_A, receipt.receipt.id))?.receipt.receipt.amount).toBe("10000");
  });
});

describe("memory policy and audit stores", () => {
  it("appends versions per tenant and refuses a stale expected version", async () => {
    const store = createMemoryPolicyStore({ clock: () => Date.parse("2026-11-23T00:00:00Z") });
    const first = await store.append(TENANT_A, "agent-1", { policyVersion: 1 }, null);
    expect(first).toEqual({
      ...TENANT_A,
      agentId: "agent-1",
      version: 1,
      policy: { policyVersion: 1 },
      createdAt: "2026-11-23T00:00:00.000Z",
    });
    expect(await store.append(TENANT_A, "agent-1", { policyVersion: 1 }, null)).toBe(
      "version-conflict",
    );
    const second = await store.append(
      TENANT_A,
      "agent-1",
      { policyVersion: 1, budgets: { daily: "100" } },
      1,
    );
    expect(second).toMatchObject({ version: 2 });
    expect((await store.versions(TENANT_A, "agent-1")).map((entry) => entry.version)).toEqual([
      1, 2,
    ]);
    expect((await store.current(TENANT_A, "agent-1"))?.version).toBe(2);
    expect(await store.current(TENANT_B, "agent-1")).toBeUndefined();

    const audit = createMemoryAuditStore({ clock: () => Date.parse("2026-11-23T00:00:00Z") });
    const entry = await audit.append(TENANT_A, {
      action: "policy.updated",
      actorKey: "admin",
      agentId: "agent-1",
      version: 1,
    });
    expect(entry).toMatchObject({ ...TENANT_A, action: "policy.updated", actorKey: "admin" });
    expect((await audit.list(TENANT_B)).entries).toEqual([]);
  });
});

describe("memory metrics, channel and admin stores", () => {
  it("isolates metrics and channels per tenant and reports counts through adminStore", async () => {
    const { stores, adminStore } = createMemoryStoresWithAdmin();
    await stores.metrics.record(TENANT_A, [
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
    expect((await stores.metrics.summarize(TENANT_A)).count).toBe(1);
    expect((await stores.metrics.summarize(TENANT_B)).count).toBe(0);

    const channels = createMemoryChannelStore();
    await expect(channels.check()).resolves.toBeUndefined();
    expect(await channels.getChannel(TENANT_A, "missing")).toBeUndefined();

    const summaries = await adminStore.listTenants();
    expect(summaries).toEqual([
      {
        ...TENANT_A,
        receipts: 0,
        metrics: 1,
        channels: 0,
        commitments: 0,
        policyVersions: 0,
        auditEntries: 0,
        totalRecords: 1,
      },
    ]);

    const standaloneMetrics = createMemoryMetricsStore();
    expect(await standaloneMetrics.count(TENANT_A)).toBe(0);
  });
});
