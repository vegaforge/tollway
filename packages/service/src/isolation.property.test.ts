import type { MppChannelAdapter } from "@vegaforge/tollway-channels";
import {
  buildReceipt,
  Ed25519Signer,
  Ed25519Verifier,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import type { PaymentMetric } from "@vegaforge/tollway-observability";
import { beforeAll, describe, expect, it } from "vitest";
import { createService } from "./app.js";
import { hashApiKey } from "./auth.js";
import { createChannelsModule } from "./channels.js";
import { parseServiceConfig, type ServiceConfig } from "./config.js";
import { ingestModule } from "./ingest.js";
import { metricsModule } from "./metrics.js";
import { policiesModule } from "./policies.js";
import { receiptsModule } from "./receipts.js";
import { createMemoryStoresWithAdmin, createTenantChannelManagers } from "./stores.js";
import { type TenantScope, tenantPartitionKey } from "./tenancy.js";
import { bearer, captureLogger } from "./test-support.js";

/**
 * Property test (#231): random interleaved writes across multiple tenants
 * with colliding receipt ids, channel ids and agent ids, followed by full HTTP
 * readbacks asserting every tenant sees 100% of its own records and 0% of any
 * other tenant's.
 *
 * Uses a deterministic mulberry32 generator pinned to `SEED` (the pattern in
 * `packages/observability/src/timeseries.test.ts`) so failures reproduce
 * identically without adding extra dependencies.
 */

const SEED = 0x517fa72e;
const RUNS = 32;
const ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type TenantFixture = {
  scope: TenantScope;
  token: string;
  sha256: string;
};

type ExpectedState = {
  receipts: Map<string, SignedReceipt>;
  settledAmount: bigint;
  metricCount: number;
  channels: Map<string, { deposit: bigint; committed: bigint; closed: boolean }>;
  policies: Map<string, { version: number; daily: string }>;
  auditCount: number;
};

describe("multi-tenant isolation property over random interleaved writes", () => {
  const seeds = Array.from({ length: RUNS }, (_, run) => (SEED + run) >>> 0);
  let verifier: Ed25519Verifier;
  let receiptPool: Map<string, SignedReceipt>;
  let tenants: TenantFixture[];
  let config: ServiceConfig;

  beforeAll(async () => {
    const signer = await Ed25519Signer.generate("prop-gate-key");
    verifier = Ed25519Verifier.forSigner(signer);

    // Pre-sign a pool of receipts covering colliding ids ("r-0".."r-5") and distinct amounts
    // so each seeded schedule exercises interleaved routing and storage rather than keygen.
    receiptPool = new Map<string, SignedReceipt>();
    for (let idIdx = 0; idIdx < 6; idIdx += 1) {
      for (let variant = 0; variant < 4; variant += 1) {
        const id = `r-${idIdx}`;
        const amount = String((variant + 1) * 1000 + idIdx * 10);
        const signed = await signReceipt(
          buildReceipt({
            id,
            issuedAt: new Date(Date.UTC(2026, 10, 24, 0, idIdx, variant)).toISOString(),
            payer: `GPAYER_V${variant}`,
            payee: `GPAYEE_I${idIdx}`,
            amount,
            asset: ASSET,
            resource: `https://api.example.com/r/${idIdx}`,
            model: "x402",
            settlement: { kind: "transaction", txHash: `tx-${idIdx}-${variant}` },
            network: "testnet",
          }),
          signer,
        );
        receiptPool.set(`${idIdx}:${variant}`, signed);
      }
    }

    const rawTenants: readonly [TenantScope, string][] = [
      [{ orgId: "org-1", projectId: "proj-1" }, "prop-key-org1-proj1-0123456789"],
      [{ orgId: "org-1", projectId: "proj-2" }, "prop-key-org1-proj2-0123456789"],
      [{ orgId: "org-2", projectId: "proj-1" }, "prop-key-org2-proj1-0123456789"],
      [{ orgId: "org-2", projectId: "proj-2" }, "prop-key-org2-proj2-0123456789"],
    ];
    tenants = await Promise.all(
      rawTenants.map(async ([scope, token]) => ({
        scope,
        token,
        sha256: await hashApiKey(token),
      })),
    );

    config = parseServiceConfig({
      env: {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_CURSOR_SECRET: "property-cursor-secret-0123456789abcdef012345",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify(
          tenants.map((t, idx) => ({
            name: `k-${idx}`,
            ...t.scope,
            sha256: t.sha256,
            scopes: ["read", "ingest", "admin"],
          })),
        ),
      },
    });
  });

  it.each(
    seeds,
  )("seed %i: preserves exact per-tenant state across interleaved writes", async (seed) => {
    const random = mulberry32(seed);
    const pickInt = (maxExclusive: number) => Math.floor(random() * maxExclusive);

    const { stores, adminStore } = createMemoryStoresWithAdmin();
    const channelSeq = new Map<string, number>();
    const adapterFor = (scope: TenantScope): MppChannelAdapter => {
      const part = tenantPartitionKey(scope);
      return {
        async openChannel() {
          const next = (channelSeq.get(part) ?? 0) + 1;
          channelSeq.set(part, next);
          // Deliberately reuse CH-1, CH-2, ... across every tenant.
          return { channelId: `CH-${next}`, openTxHash: `open-${part}-${next}` };
        },
        async signCommitment(input) {
          return { commitment: `blob:${part}:${input.channelId}:${input.cumulativeAmount}` };
        },
        async closeChannel(input) {
          return {
            settlementTxHash: `close-${part}-${input.channelId}`,
            settledAmount: input.cumulativeAmount,
            returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
          };
        },
        async getChannelState() {
          return { balance: "0", currentLedger: 100 };
        },
        async findChannelSettlement() {
          return null;
        },
        // Tenant isolation never recovers a channel; these fail loudly if it does.
        async getState() {
          throw new Error("the isolation tests do not read recovery state");
        },
        async startClose() {
          throw new Error("the isolation tests do not start a funder close");
        },
        async refund() {
          throw new Error("the isolation tests do not refund");
        },
      };
    };

    let tick = 0;
    const channelManagers = createTenantChannelManagers({
      store: stores.channels,
      adapter: adapterFor,
      now: () => new Date(Date.UTC(2026, 10, 24, 3, 0, tick++)).toISOString(),
    });

    const app = createService({
      config,
      stores,
      adminStore,
      logger: captureLogger(),
      channelManagers,
      modules: [
        metricsModule(),
        createChannelsModule({ now: () => "2026-11-24T04:00:00.000Z" }),
        receiptsModule({ verifier }),
        policiesModule(),
        ingestModule({ verifier }),
      ],
    });

    const expected = new Map<string, ExpectedState>();
    for (const tenant of tenants) {
      expected.set(tenantPartitionKey(tenant.scope), {
        receipts: new Map(),
        settledAmount: 0n,
        metricCount: 0,
        channels: new Map(),
        policies: new Map(),
        auditCount: 0,
      });
    }

    const steps = 14 + pickInt(12);
    for (let step = 0; step < steps; step += 1) {
      const tenantIdx = pickInt(tenants.length);
      const tenant = tenants[tenantIdx];
      if (tenant === undefined) throw new Error("missing tenant");
      const model = expected.get(tenantPartitionKey(tenant.scope));
      if (model === undefined) throw new Error("missing model");

      const op = pickInt(6);
      if (op === 0) {
        const idIdx = pickInt(6);
        const candidate = receiptPool.get(`${idIdx}:${tenantIdx}`);
        if (candidate === undefined) throw new Error("missing receipt fixture");
        const res = await app.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(tenant.token), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [candidate] }),
        });
        expect(res.status).toBe(202);
        if (!model.receipts.has(candidate.receipt.id)) {
          model.receipts.set(candidate.receipt.id, candidate);
        }
      } else if (op === 1) {
        const amount = BigInt(100 + pickInt(9000));
        const settled = pickInt(3) !== 0;
        const metric: PaymentMetric = {
          payer: `GP_${tenantIdx}_${pickInt(2)}`,
          payee: `GS_${pickInt(2)}`,
          model: "x402",
          amount: amount.toString(),
          asset: ASSET,
          latencyMs: 5 + pickInt(50),
          outcome: settled ? "settled" : "failed",
          at: new Date(Date.UTC(2026, 10, 24, 2, 0, step)).toISOString(),
        };
        const res = await app.request("/v1/metrics", {
          method: "POST",
          headers: { ...bearer(tenant.token), "Content-Type": "application/json" },
          body: JSON.stringify({ metrics: [metric] }),
        });
        expect(res.status).toBe(202);
        model.metricCount += 1;
        if (settled) model.settledAmount += amount;
      } else if (op === 2) {
        const manager = channelManagers(tenant.scope);
        const openChannels = [...model.channels.entries()].filter(([, ch]) => !ch.closed);
        if (openChannels.length === 0 || pickInt(2) === 0) {
          const ch = await manager.open({
            counterparty: `GCP_${tenantIdx}`,
            asset: ASSET,
            deposit: "10000",
            network: "testnet",
          });
          model.channels.set(ch.id, { deposit: 10000n, committed: 0n, closed: false });
        } else {
          const target = openChannels[pickInt(openChannels.length)];
          if (target !== undefined) {
            const [chId, info] = target;
            if (info.committed + 500n <= info.deposit) {
              await manager.commit(chId, "500");
              info.committed += 500n;
            }
          }
        }
      } else if (op === 3) {
        const openChannels = [...model.channels.entries()].filter(([, ch]) => !ch.closed);
        const target = openChannels[pickInt(openChannels.length)];
        if (target !== undefined) {
          const [chId, info] = target;
          const res = await app.request(`/v1/channels/${chId}/close`, {
            method: "POST",
            headers: bearer(tenant.token),
          });
          expect(res.status).toBe(200);
          info.closed = true;
          model.auditCount += 1;
        }
      } else if (op === 4) {
        const agentId = `agent-${pickInt(3)}`;
        const current = model.policies.get(agentId);
        const daily = String(1000 * ((current?.version ?? 0) + 1) + tenantIdx);
        const res = await app.request(`/v1/agents/${agentId}/policy`, {
          method: "PUT",
          headers: { ...bearer(tenant.token), "Content-Type": "application/json" },
          body: JSON.stringify({
            policy: { policyVersion: 1, budgets: { daily } },
            expectedVersion: current?.version ?? null,
          }),
        });
        expect(res.status).toBe(200);
        model.policies.set(agentId, { version: (current?.version ?? 0) + 1, daily });
        model.auditCount += 1;
      } else {
        const amount = BigInt(50 + pickInt(4000));
        const res = await app.request("/v1/ingest", {
          method: "POST",
          headers: { ...bearer(tenant.token), "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `idem-${step}`,
            metrics: [
              {
                ...tenant.scope,
                payer: `GP_${tenantIdx}_${pickInt(2)}`,
                payee: `GS_${pickInt(2)}`,
                model: "x402",
                amount: amount.toString(),
                asset: ASSET,
                latencyMs: 12,
                outcome: "settled",
                at: new Date(Date.UTC(2026, 10, 24, 2, 30, step)).toISOString(),
              },
            ],
          }),
        });
        expect(res.status).toBe(202);
        model.metricCount += 1;
        model.settledAmount += amount;
      }
    }

    // Verify every tenant reads back strictly and completely its own state.
    for (const tenant of tenants) {
      const model = expected.get(tenantPartitionKey(tenant.scope));
      if (model === undefined) throw new Error("missing model");
      const headers = bearer(tenant.token);

      // 1. Paginated receipts
      const pagedReceipts: SignedReceipt[] = [];
      let rCursor: string | undefined;
      do {
        const url =
          rCursor === undefined ? "/v1/receipts?limit=2" : `/v1/receipts?limit=2&cursor=${rCursor}`;
        const page = (await (await app.request(url, { headers })).json()) as {
          receipts: SignedReceipt[];
          nextCursor?: string;
        };
        pagedReceipts.push(...page.receipts);
        rCursor = page.nextCursor;
      } while (rCursor !== undefined);

      expect(pagedReceipts).toHaveLength(model.receipts.size);
      for (const item of pagedReceipts) {
        expect(item).toEqual(model.receipts.get(item.receipt.id));
      }

      // 2. Metrics summary, timeseries, and JSON export
      const summary = (await (await app.request("/v1/metrics/summary", { headers })).json()) as {
        count: number;
        byAsset: Array<{ asset: string; amount: string }>;
      };
      expect(summary.count).toBe(model.metricCount);
      const assetTotal = summary.byAsset.find((a) => a.asset === ASSET)?.amount ?? "0";
      expect(assetTotal).toBe(model.settledAmount.toString());

      const timeseries = (await (
        await app.request(
          "/v1/metrics/series?from=2026-11-24T00:00:00.000Z&to=2026-11-24T05:00:00.000Z&bucket=1h",
          { headers },
        )
      ).json()) as {
        buckets: Array<{ rows: Array<{ asset: string; amount: string }> }>;
      };
      const seriesAmount = timeseries.buckets
        .flatMap((b) => b.rows)
        .filter((r) => r.asset === ASSET)
        .reduce((sum, r) => sum + BigInt(r.amount), 0n);
      expect(seriesAmount).toBe(model.settledAmount);

      const exported = (await (
        await app.request("/v1/metrics/export?format=json", { headers })
      ).json()) as PaymentMetric[];
      expect(exported).toHaveLength(model.metricCount);

      // 3. Channels
      const channelList = (await (await app.request("/v1/channels", { headers })).json()) as {
        channels: Array<{ id: string; committed: string; status: string }>;
      };
      expect(channelList.channels).toHaveLength(model.channels.size);
      for (const ch of channelList.channels) {
        const expectedChannel = model.channels.get(ch.id);
        expect(expectedChannel).toBeDefined();
        expect(ch.committed).toBe(expectedChannel?.committed.toString());
        expect(ch.status).toBe(expectedChannel?.closed ? "closed" : "open");
      }

      // 4. Policies and audit entries
      for (const agentId of ["agent-0", "agent-1", "agent-2"]) {
        const res = await app.request(`/v1/agents/${agentId}/policy`, { headers });
        const expectedPolicy = model.policies.get(agentId);
        if (expectedPolicy === undefined) {
          expect(res.status).toBe(404);
        } else {
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({
            ...tenant.scope,
            agentId,
            version: expectedPolicy.version,
            policy: { budgets: { daily: expectedPolicy.daily } },
          });
        }
      }

      const auditRes = (await (await app.request("/v1/audit?limit=200", { headers })).json()) as {
        entries: Array<{ orgId: string; projectId: string }>;
      };
      expect(auditRes.entries).toHaveLength(model.auditCount);
      for (const entry of auditRes.entries) {
        expect(entry.orgId).toBe(tenant.scope.orgId);
        expect(entry.projectId).toBe(tenant.scope.projectId);
      }
    }
  });
});
