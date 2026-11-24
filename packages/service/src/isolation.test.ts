import type { MppChannelAdapter } from "@vegaforge/tollway-channels";
import {
  type BuildReceiptInput,
  buildReceipt,
  Ed25519Signer,
  Ed25519Verifier,
  type ReceiptVerifier,
  signReceipt,
} from "@vegaforge/tollway-core";
import type { TollwayEventInput } from "@vegaforge/tollway-observability";
import { describe, expect, it, vi } from "vitest";
import { adminModule } from "./admin.js";
import { createService } from "./app.js";
import { hashApiKey } from "./auth.js";
import { createChannelsModule } from "./channels.js";
import { parseServiceConfig, type QuotasConfig } from "./config.js";
import { ingestModule } from "./ingest.js";
import { metricsModule } from "./metrics.js";
import type { OpenApiDocument } from "./openapi.js";
import { policiesModule } from "./policies.js";
import {
  type PostgresPoolClient,
  serviceTenantMigrations,
  withOperatorReadTransaction,
  withTenantTransaction,
} from "./postgres-rls.js";
import { receiptsModule } from "./receipts.js";
import {
  createMemoryStores,
  createMemoryStoresWithAdmin,
  createTenantChannelManagers,
} from "./stores.js";
import type { TenantScope } from "./tenancy.js";
import { bearer, captureLogger } from "./test-support.js";

const TENANT_A: TenantScope = { orgId: "org-alpha", projectId: "proj-one" };
const TENANT_A2: TenantScope = { orgId: "org-alpha", projectId: "proj-two" };
const TENANT_B: TenantScope = { orgId: "org-bravo", projectId: "proj-one" };

const KEY_A = "tenant-alpha-one-key-0123456789abcdef";
const KEY_A2 = "tenant-alpha-two-key-0123456789abcdef";
const KEY_B = "tenant-bravo-one-key-0123456789abcdef";
const KEY_OP = "root-operator-key-0123456789abcdef";

const ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function deterministicAdapter() {
  const counters = new Map<string, number>();
  const closeCalls: string[] = [];

  const forTenant = (tenant: TenantScope): MppChannelAdapter => {
    const scopeKey = `${tenant.orgId}/${tenant.projectId}`;
    return {
      async openChannel() {
        const next = (counters.get(scopeKey) ?? 0) + 1;
        counters.set(scopeKey, next);
        return {
          channelId: `CH${String(next).padStart(3, "0")}`,
          openTxHash: `tx-open-${scopeKey}-${next}`,
        };
      },
      async signCommitment(input) {
        return { commitment: `sig:${scopeKey}:${input.channelId}:${input.cumulativeAmount}` };
      },
      async closeChannel(input) {
        closeCalls.push(`${scopeKey}:${input.channelId}`);
        return {
          settlementTxHash: `tx-close-${scopeKey}-${input.channelId}`,
          settledAmount: input.cumulativeAmount,
          returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
        };
      },
      async getChannelState() {
        return { balance: "0", currentLedger: 500 };
      },
      async findChannelSettlement() {
        return null;
      },
    };
  };

  return { forTenant, closeCalls };
}

function receiptInput(overrides: Partial<BuildReceiptInput> = {}): BuildReceiptInput {
  return {
    payer: "GPAYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    payee: "GPAYEEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: "25000",
    asset: ASSET,
    resource: "https://api.bravo.example/v1/infer",
    model: "x402",
    settlement: { kind: "transaction", txHash: "tx-bravo-001" },
    network: "testnet",
    ...overrides,
  };
}

async function buildHarness(options?: {
  quotas?: QuotasConfig;
  quotaClock?: () => number;
  verifierWrapper?: (inner: ReceiptVerifier) => ReceiptVerifier;
}) {
  const signer = await Ed25519Signer.generate("gate-key-1");
  const baseVerifier = Ed25519Verifier.forSigner(signer);
  const verifier = options?.verifierWrapper ? options.verifierWrapper(baseVerifier) : baseVerifier;

  const { stores, adminStore } = createMemoryStoresWithAdmin();
  const { forTenant, closeCalls } = deterministicAdapter();
  let channelTick = 0;
  const channelManagers = createTenantChannelManagers({
    store: stores.channels,
    adapter: forTenant,
    now: () => new Date(Date.UTC(2026, 10, 24, 1, 0, channelTick++)).toISOString(),
  });

  const emitted: TollwayEventInput[] = [];
  const observability = {
    emit: vi.fn(async (event: TollwayEventInput) => {
      emitted.push(event);
      return {
        event: { ...event, id: event.id ?? "evt-1" },
        handlersDispatched: 0,
        webhooksDispatched: 0,
        failures: [],
      };
    }),
  };

  const config = parseServiceConfig({
    env: {
      TOLLWAY_SERVICE_PORT: "8787",
      TOLLWAY_SERVICE_CURSOR_SECRET: "cursor-hmac-secret-0123456789abcdef0123456789",
      TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
        {
          name: "alpha-one",
          ...TENANT_A,
          sha256: await hashApiKey(KEY_A),
          scopes: ["read", "ingest", "admin"],
        },
        {
          name: "alpha-two",
          ...TENANT_A2,
          sha256: await hashApiKey(KEY_A2),
          scopes: ["read", "ingest", "admin"],
        },
        {
          name: "bravo-one",
          ...TENANT_B,
          sha256: await hashApiKey(KEY_B),
          scopes: ["read", "ingest", "admin"],
        },
      ]),
      TOLLWAY_SERVICE_OPERATOR_KEYS: JSON.stringify([
        {
          name: "ops-root",
          sha256: await hashApiKey(KEY_OP),
        },
      ]),
      ...(options?.quotas === undefined
        ? {}
        : { TOLLWAY_SERVICE_QUOTAS: JSON.stringify(options.quotas) }),
    },
  });

  const logger = captureLogger();
  const app = createService({
    config,
    stores,
    adminStore,
    logger,
    channelManagers,
    observability,
    ...(options?.quotaClock === undefined ? {} : { quotaClock: options.quotaClock }),
    modules: [
      metricsModule({ now: () => Date.parse("2026-11-24T12:00:00.000Z") }),
      createChannelsModule({ now: () => "2026-11-24T12:00:00.000Z" }),
      receiptsModule({ verifier }),
      policiesModule(),
      ingestModule({ verifier }),
      adminModule(),
    ],
  });

  return { app, signer, stores, adminStore, channelManagers, closeCalls, emitted, logger };
}

async function seedTenantB(harness: Awaited<ReturnType<typeof buildHarness>>) {
  const { app, signer, channelManagers } = harness;

  const r1 = await signReceipt(
    buildReceipt(
      receiptInput({ id: "rcpt-b-1", issuedAt: "2026-11-24T10:00:00.000Z", amount: "11111" }),
    ),
    signer,
  );
  const r2 = await signReceipt(
    buildReceipt(
      receiptInput({ id: "rcpt-b-2", issuedAt: "2026-11-24T10:01:00.000Z", amount: "22222" }),
    ),
    signer,
  );

  const postReceipts = await app.request("/v1/receipts", {
    method: "POST",
    headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
    body: JSON.stringify({ receipts: [r1, r2] }),
  });
  expect(postReceipts.status).toBe(202);

  const postMetrics = await app.request("/v1/metrics", {
    method: "POST",
    headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
    body: JSON.stringify({
      metrics: [
        {
          payer: "GBRAVO_PAYER",
          payee: "GBRAVO_PAYEE",
          model: "x402",
          amount: "77777",
          asset: ASSET,
          latencyMs: 19,
          outcome: "settled",
          at: "2026-11-24T10:05:00.000Z",
        },
      ],
    }),
  });
  expect(postMetrics.status).toBe(202);

  const managerB = channelManagers(TENANT_B);
  const ch1 = await managerB.open({
    counterparty: "GBRAVO_SERVICE_1",
    asset: ASSET,
    deposit: "5000",
    network: "testnet",
  });
  await managerB.commit(ch1.id, "1000");
  await managerB.commit(ch1.id, "1500");
  await managerB.open({
    counterparty: "GBRAVO_SERVICE_2",
    asset: ASSET,
    deposit: "3000",
    network: "testnet",
  });

  for (const [expectedVersion, daily] of [
    [null, "50000"],
    [1, "90000"],
  ] as const) {
    const putPolicy = await app.request("/v1/agents/agent-bravo/policy", {
      method: "PUT",
      headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
      body: JSON.stringify({
        policy: { policyVersion: 1, budgets: { daily } },
        expectedVersion,
      }),
    });
    expect(putPolicy.status).toBe(200);
  }

  const receiptsPage = (await (
    await app.request("/v1/receipts?limit=1", { headers: bearer(KEY_B) })
  ).json()) as { nextCursor: string };
  const channelsPage = (await (
    await app.request("/v1/channels?limit=1", { headers: bearer(KEY_B) })
  ).json()) as { nextCursor: string };
  const commitmentsPage = (await (
    await app.request(`/v1/channels/${ch1.id}/commitments?limit=1`, { headers: bearer(KEY_B) })
  ).json()) as { nextCursor: string };
  const auditPage = (await (
    await app.request("/v1/audit?limit=1", { headers: bearer(KEY_B) })
  ).json()) as { nextCursor: string };

  return {
    receipt: r1,
    channelId: ch1.id,
    agentId: "agent-bravo",
    cursors: {
      receipts: receiptsPage.nextCursor,
      channels: channelsPage.nextCursor,
      commitments: commitmentsPage.nextCursor,
      audit: auditPage.nextCursor,
    },
  };
}

describe("table-driven cross-tenant route isolation", () => {
  type DirectCrossTenantCase = {
    name: string;
    method: "GET" | "POST" | "PUT";
    path: (seeded: Awaited<ReturnType<typeof seedTenantB>>) => string;
    body?: (
      seeded: Awaited<ReturnType<typeof seedTenantB>>,
      harness: Awaited<ReturnType<typeof buildHarness>>,
    ) => unknown;
    expectedStatus: 403 | 404;
  };

  const directCases: readonly DirectCrossTenantCase[] = [
    {
      name: "GET /v1/receipts/{id} for tenant B's receipt",
      method: "GET",
      path: (s) => `/v1/receipts/${s.receipt.receipt.id}`,
      expectedStatus: 404,
    },
    {
      name: "POST /v1/receipts claiming tenant B's orgId and projectId",
      method: "POST",
      path: () => "/v1/receipts",
      body: (s) => ({ ...TENANT_B, receipts: [s.receipt] }),
      expectedStatus: 403,
    },
    {
      name: "POST /v1/metrics claiming tenant B's orgId",
      method: "POST",
      path: () => "/v1/metrics",
      body: () => ({
        metrics: [
          {
            ...TENANT_B,
            payer: "GA",
            payee: "GB",
            model: "x402",
            amount: "10",
            asset: ASSET,
            latencyMs: 5,
            outcome: "settled",
            at: "2026-11-24T10:10:00.000Z",
          },
        ],
      }),
      expectedStatus: 403,
    },
    {
      name: "GET /v1/channels/{id} for tenant B's channel",
      method: "GET",
      path: (s) => `/v1/channels/${s.channelId}`,
      expectedStatus: 404,
    },
    {
      name: "GET /v1/channels/{id}/commitments for tenant B's channel",
      method: "GET",
      path: (s) => `/v1/channels/${s.channelId}/commitments?include=blob`,
      expectedStatus: 404,
    },
    {
      name: "POST /v1/channels/{id}/close on tenant B's open channel",
      method: "POST",
      path: (s) => `/v1/channels/${s.channelId}/close`,
      expectedStatus: 404,
    },
    {
      name: "GET /v1/agents/{agentId}/policy for tenant B's agent",
      method: "GET",
      path: (s) => `/v1/agents/${s.agentId}/policy`,
      expectedStatus: 404,
    },
    {
      name: "GET /v1/agents/{agentId}/policy/versions for tenant B's agent",
      method: "GET",
      path: (s) => `/v1/agents/${s.agentId}/policy/versions`,
      expectedStatus: 404,
    },
    {
      name: "POST /v1/ingest claiming tenant B on an item",
      method: "POST",
      path: () => "/v1/ingest",
      body: () => ({
        metrics: [
          {
            orgId: TENANT_B.orgId,
            projectId: TENANT_B.projectId,
            payer: "GA",
            payee: "GB",
            model: "x402",
            amount: "10",
            asset: ASSET,
            latencyMs: 5,
            outcome: "settled",
            at: "2026-11-24T10:10:00.000Z",
          },
        ],
      }),
      expectedStatus: 403,
    },
    {
      name: "GET /v1/admin/tenants with a tenant admin key",
      method: "GET",
      path: () => "/v1/admin/tenants",
      expectedStatus: 403,
    },
  ];

  it.each(directCases)("$name -> $expectedStatus (never 200 with B's data)", async (entry) => {
    const harness = await buildHarness();
    const seeded = await seedTenantB(harness);
    const payload = entry.body?.(seeded, harness);

    const response = await harness.app.request(entry.path(seeded), {
      method: entry.method,
      headers: {
        ...bearer(KEY_A),
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    expect(response.status).toBe(entry.expectedStatus);
    const raw = await response.text();
    expect(raw).not.toContain("GBRAVO");
    expect(raw).not.toContain("77777");
    expect(raw).not.toContain("90000");
    expect(harness.closeCalls).toEqual([]);
  });

  type CollectionRouteCase = {
    name: string;
    path: string;
    assertEmptyForA: (response: Response, bodyText: string) => void;
    overrideAttemptPath: string;
  };

  const collectionCases: readonly CollectionRouteCase[] = [
    {
      name: "GET /v1/receipts",
      path: "/v1/receipts",
      overrideAttemptPath: `/v1/receipts?orgId=${TENANT_B.orgId}`,
      assertEmptyForA: (_res, text) => {
        expect(JSON.parse(text)).toEqual({ receipts: [] });
      },
    },
    {
      name: "GET /v1/metrics/summary",
      path: "/v1/metrics/summary",
      overrideAttemptPath: `/v1/metrics/summary?orgId=${TENANT_B.orgId}`,
      assertEmptyForA: (_res, text) => {
        expect(JSON.parse(text)).toMatchObject({ count: 0, byAsset: [], byPayer: [], byPayee: [] });
      },
    },
    {
      name: "GET /v1/metrics/series",
      path: "/v1/metrics/series?from=2026-11-24T10:00:00.000Z&to=2026-11-24T11:00:00.000Z&bucket=1h",
      overrideAttemptPath: `/v1/metrics/series?from=2026-11-24T10:00:00.000Z&to=2026-11-24T11:00:00.000Z&bucket=1h&projectId=${TENANT_B.projectId}`,
      assertEmptyForA: (_res, text) => {
        const parsed = JSON.parse(text) as { buckets: Array<{ rows: unknown[] }> };
        expect(parsed.buckets.every((bucket) => bucket.rows.length === 0)).toBe(true);
      },
    },
    {
      name: "GET /v1/metrics/export (json)",
      path: "/v1/metrics/export?format=json",
      overrideAttemptPath: `/v1/metrics/export?format=json&orgId=${TENANT_B.orgId}`,
      assertEmptyForA: (_res, text) => {
        expect(JSON.parse(text)).toEqual([]);
      },
    },
    {
      name: "GET /v1/metrics/export (csv)",
      path: "/v1/metrics/export?format=csv",
      overrideAttemptPath: `/v1/metrics/export?format=csv&projectId=${TENANT_B.projectId}`,
      assertEmptyForA: (_res, text) => {
        expect(text.split("\r\n")).toEqual(["payer,payee,model,amount,asset,latencyMs,outcome,at"]);
      },
    },
    {
      name: "GET /v1/channels",
      path: "/v1/channels",
      overrideAttemptPath: `/v1/channels?orgId=${TENANT_B.orgId}`,
      assertEmptyForA: (_res, text) => {
        expect(JSON.parse(text)).toEqual({ channels: [] });
      },
    },
    {
      name: "GET /v1/audit",
      path: "/v1/audit",
      overrideAttemptPath: `/v1/audit?orgId=${TENANT_B.orgId}`,
      assertEmptyForA: (_res, text) => {
        expect(JSON.parse(text)).toEqual({ entries: [] });
      },
    },
  ];

  it.each(
    collectionCases,
  )("$name returns only tenant A's empty partition and rejects query tenant overrides with 400", async (entry) => {
    const harness = await buildHarness();
    await seedTenantB(harness);

    const response = await harness.app.request(entry.path, { headers: bearer(KEY_A) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("GBRAVO");
    expect(text).not.toContain("77777");
    entry.assertEmptyForA(response, text);

    const overrideRes = await harness.app.request(entry.overrideAttemptPath, {
      headers: bearer(KEY_A),
    });
    expect(overrideRes.status).toBe(400);
  });

  it.each([
    [
      "receipts cursor",
      (s: Awaited<ReturnType<typeof seedTenantB>>) =>
        `/v1/receipts?limit=1&cursor=${s.cursors.receipts}`,
    ],
    [
      "channels cursor",
      (s: Awaited<ReturnType<typeof seedTenantB>>) =>
        `/v1/channels?limit=1&cursor=${s.cursors.channels}`,
    ],
    [
      "channel commitments cursor",
      (s: Awaited<ReturnType<typeof seedTenantB>>) =>
        `/v1/channels/${s.channelId}/commitments?limit=1&cursor=${s.cursors.commitments}`,
    ],
    [
      "audit cursor",
      (s: Awaited<ReturnType<typeof seedTenantB>>) => `/v1/audit?limit=1&cursor=${s.cursors.audit}`,
    ],
  ])("replaying tenant B's %s under tenant A's key returns 400, even on colliding channel ids", async (_label, makePath) => {
    const harness = await buildHarness();
    const seeded = await seedTenantB(harness);
    // Open CH001 in tenant A as well so the channel id exists in both tenants.
    await harness.channelManagers(TENANT_A).open({
      counterparty: "GALPHA_SERVICE",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });

    const response = await harness.app.request(makePath(seeded), { headers: bearer(KEY_A) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid-request" } });
  });

  it("rejects cursors replayed across two projects in the same org (org-alpha/proj-one vs org-alpha/proj-two)", async () => {
    const harness = await buildHarness();
    // Seed 2 items of each paginated kind in TENANT_B (org-bravo/proj-one) and TENANT_A (org-alpha/proj-one),
    // then replay TENANT_A's cursors under KEY_A2 (org-alpha/proj-two, identical orgId).
    const r1 = await signReceipt(buildReceipt(receiptInput({ id: "a-cur-1" })), harness.signer);
    const r2 = await signReceipt(buildReceipt(receiptInput({ id: "a-cur-2" })), harness.signer);
    await harness.app.request("/v1/receipts", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({ receipts: [r1, r2] }),
    });
    const ch1 = await harness.channelManagers(TENANT_A).open({
      counterparty: "GALPHA_1",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });
    await harness.channelManagers(TENANT_A).open({
      counterparty: "GALPHA_2",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });
    await harness.channelManagers(TENANT_A).commit(ch1.id, "100");
    await harness.channelManagers(TENANT_A).commit(ch1.id, "100");
    // Open colliding CH001 in TENANT_A2 as well so channel lookup alone would succeed.
    await harness.channelManagers(TENANT_A2).open({
      counterparty: "GALPHA2_1",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });
    for (const agentId of ["ag-1", "ag-2"]) {
      await harness.app.request(`/v1/agents/${agentId}/policy`, {
        method: "PUT",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify({ policy: { policyVersion: 1, budgets: { daily: "100" } } }),
      });
    }

    const rCur = (
      await (await harness.app.request("/v1/receipts?limit=1", { headers: bearer(KEY_A) })).json()
    ).nextCursor as string;
    const cCur = (
      await (await harness.app.request("/v1/channels?limit=1", { headers: bearer(KEY_A) })).json()
    ).nextCursor as string;
    const mCur = (
      await (
        await harness.app.request(`/v1/channels/${ch1.id}/commitments?limit=1`, {
          headers: bearer(KEY_A),
        })
      ).json()
    ).nextCursor as string;
    const aCur = (
      await (await harness.app.request("/v1/audit?limit=1", { headers: bearer(KEY_A) })).json()
    ).nextCursor as string;

    for (const path of [
      `/v1/receipts?limit=1&cursor=${rCur}`,
      `/v1/channels?limit=1&cursor=${cCur}`,
      `/v1/channels/${ch1.id}/commitments?limit=1&cursor=${mCur}`,
      `/v1/audit?limit=1&cursor=${aCur}`,
    ]) {
      const replay = await harness.app.request(path, { headers: bearer(KEY_A2) });
      expect(replay.status).toBe(400);
      expect(await replay.json()).toMatchObject({ error: { code: "invalid-request" } });
    }
  });

  it("rejects a cursor replayed by the same tenant with modified query filters", async () => {
    const harness = await buildHarness();
    const seeded = await seedTenantB(harness);

    const changedChannelFilter = await harness.app.request(
      `/v1/channels?limit=1&status=open&cursor=${seeded.cursors.channels}`,
      { headers: bearer(KEY_B) },
    );
    expect(changedChannelFilter.status).toBe(400);

    const changedReceiptFilter = await harness.app.request(
      `/v1/receipts?limit=1&payer=SOMEONE_ELSE&cursor=${seeded.cursors.receipts}`,
      { headers: bearer(KEY_B) },
    );
    expect(changedReceiptFilter.status).toBe(400);

    const changedCommitmentInclude = await harness.app.request(
      `/v1/channels/${seeded.channelId}/commitments?limit=1&include=blob&cursor=${seeded.cursors.commitments}`,
      { headers: bearer(KEY_B) },
    );
    expect(changedCommitmentInclude.status).toBe(400);

    const changedAuditFilter = await harness.app.request(
      `/v1/audit?limit=1&agentId=agent-bravo&cursor=${seeded.cursors.audit}`,
      { headers: bearer(KEY_B) },
    );
    expect(changedAuditFilter.status).toBe(400);
  });

  it("prevents PUT /v1/agents/{agentId}/policy and GET /v1/whoami from reading or altering tenant B, and covers every /v1 route in /openapi.json", async () => {
    const harness = await buildHarness();
    const seeded = await seedTenantB(harness);

    const whoamiA = await (
      await harness.app.request("/v1/whoami", { headers: bearer(KEY_A) })
    ).json();
    expect(whoamiA).toEqual({
      name: "alpha-one",
      ...TENANT_A,
      scopes: ["read", "ingest", "admin"],
    });

    // Attempting to inject orgId in the policy body fails strict schema validation (400).
    const injectedOrg = await harness.app.request(`/v1/agents/${seeded.agentId}/policy`, {
      method: "PUT",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: TENANT_B.orgId,
        policy: { policyVersion: 1 },
        expectedVersion: 2,
      }),
    });
    expect(injectedOrg.status).toBe(400);

    // Targeting tenant B's current version (2) under tenant A's key fails optimistic concurrency (409)
    // because tenant A has no policy for agent-bravo, and leaves tenant B's policy intact.
    const crossVersionAttempt = await harness.app.request(`/v1/agents/${seeded.agentId}/policy`, {
      method: "PUT",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        policy: { policyVersion: 1, budgets: { daily: "1" } },
        expectedVersion: 2,
      }),
    });
    expect(crossVersionAttempt.status).toBe(409);

    const intactB = await (
      await harness.app.request(`/v1/agents/${seeded.agentId}/policy`, { headers: bearer(KEY_B) })
    ).json();
    expect(intactB).toMatchObject({
      ...TENANT_B,
      version: 2,
      policy: { budgets: { daily: "90000" } },
    });

    // Lock route coverage: every authenticated /v1 operation in /openapi.json is exercised above.
    const openApi = (await (await harness.app.request("/openapi.json")).json()) as OpenApiDocument;
    const allV1Operations = Object.entries(openApi.paths)
      .filter(([path]) => path.startsWith("/v1/"))
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();

    expect(allV1Operations).toEqual([
      "GET /v1/admin/tenants",
      "GET /v1/agents/{agentId}/policy",
      "GET /v1/agents/{agentId}/policy/versions",
      "GET /v1/audit",
      "GET /v1/channels",
      "GET /v1/channels/{id}",
      "GET /v1/channels/{id}/commitments",
      "GET /v1/metrics/export",
      "GET /v1/metrics/series",
      "GET /v1/metrics/summary",
      "GET /v1/receipts",
      "GET /v1/receipts/{id}",
      "GET /v1/whoami",
      "POST /v1/channels/{id}/close",
      "POST /v1/ingest",
      "POST /v1/metrics",
      "POST /v1/receipts",
      "PUT /v1/agents/{agentId}/policy",
    ]);
  });

  it("verifies receipt signatures on ingest, reports same-tenant conflicts with 409, and makes zero outbound fetch calls", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("unexpected outbound network call");
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const harness = await buildHarness();
      const { app, signer } = harness;

      const honest = await signReceipt(
        buildReceipt(receiptInput({ id: "tamper-test-1", amount: "500" })),
        signer,
      );
      const tampered = {
        ...honest,
        receipt: { ...honest.receipt, amount: "999999" },
      };
      const rejectedTamper = await app.request("/v1/receipts", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify({ receipts: [tampered] }),
      });
      expect(rejectedTamper.status).toBe(400);

      expect(
        (
          await app.request("/v1/receipts", {
            method: "POST",
            headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
            body: JSON.stringify({ receipts: [honest] }),
          })
        ).status,
      ).toBe(202);

      const conflicting = await signReceipt(
        buildReceipt(receiptInput({ id: "tamper-test-1", amount: "700" })),
        signer,
      );
      const conflictRes = await app.request("/v1/receipts", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify({ receipts: [conflicting] }),
      });
      expect(conflictRes.status).toBe(409);

      const adminRes = await app.request("/v1/admin/tenants", { headers: bearer(KEY_OP) });
      expect(adminRes.status).toBe(200);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("id collisions across orgs and projects", () => {
  it("allows identical receipt ids, channel ids and agent ids across two projects without conflict", async () => {
    const harness = await buildHarness();
    const { app, signer, channelManagers, emitted } = harness;

    // Identical receipt id "shared-rcpt-1" with different signed amounts in two projects of the same org.
    const receiptA1 = await signReceipt(
      buildReceipt(receiptInput({ id: "shared-rcpt-1", amount: "1000" })),
      signer,
    );
    const receiptA2 = await signReceipt(
      buildReceipt(receiptInput({ id: "shared-rcpt-1", amount: "9999" })),
      signer,
    );

    expect(
      (
        await app.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [receiptA1] }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await app.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(KEY_A2), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [receiptA2] }),
        })
      ).status,
    ).toBe(202);

    const readReceiptA1 = await (
      await app.request("/v1/receipts/shared-rcpt-1", { headers: bearer(KEY_A) })
    ).json();
    const readReceiptA2 = await (
      await app.request("/v1/receipts/shared-rcpt-1", { headers: bearer(KEY_A2) })
    ).json();
    expect(readReceiptA1.receipt.amount).toBe("1000");
    expect(readReceiptA2.receipt.amount).toBe("9999");

    // Identical channel id "CH001" in both projects; closing one leaves the other open.
    const chA1 = await channelManagers(TENANT_A).open({
      counterparty: "GP_A1",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });
    const chA2 = await channelManagers(TENANT_A2).open({
      counterparty: "GP_A2",
      asset: ASSET,
      deposit: "2000",
      network: "testnet",
    });
    expect(chA1.id).toBe("CH001");
    expect(chA2.id).toBe("CH001");

    const closeRes = await app.request("/v1/channels/CH001/close", {
      method: "POST",
      headers: bearer(KEY_A),
    });
    expect(closeRes.status).toBe(200);
    expect(await closeRes.json()).toMatchObject({
      id: "CH001",
      status: "closed",
      closeRequest: { requestedBy: "alpha-one" },
    });

    const stillOpenInA2 = await (
      await app.request("/v1/channels/CH001", { headers: bearer(KEY_A2) })
    ).json();
    expect(stillOpenInA2).toMatchObject({
      id: "CH001",
      status: "open",
      deposit: "2000",
    });
    expect(stillOpenInA2).not.toHaveProperty("closeRequest");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({ ...TENANT_A, channelId: "CH001" });

    // Identical agentId "shared-agent" starts at version 1 independently in both projects.
    for (const [key, daily] of [
      [KEY_A, "100"],
      [KEY_A2, "200"],
    ] as const) {
      const res = await app.request("/v1/agents/shared-agent/policy", {
        method: "PUT",
        headers: { ...bearer(key), "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: { policyVersion: 1, budgets: { daily } },
          expectedVersion: null,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ version: 1, policy: { budgets: { daily } } });
    }
  });
});

describe("batch ingest (#229) tenant claims and scoped deduplication", () => {
  it("rejects the entire batch with 403 when any item, flat receipt or non-string event data claims another tenant", async () => {
    const harness = await buildHarness();
    const { app, signer, stores } = harness;
    const validReceipt = await signReceipt(buildReceipt(receiptInput({ id: "batch-r1" })), signer);

    const eventMismatch = await app.request("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "batch-1",
        receipts: [validReceipt],
        metrics: [
          {
            payer: "GA",
            payee: "GB",
            model: "x402",
            amount: "50",
            asset: ASSET,
            latencyMs: 8,
            outcome: "settled",
            at: "2026-11-24T11:00:00.000Z",
          },
        ],
        events: [
          {
            type: "receipt.created",
            at: "2026-11-24T11:00:00.000Z",
            projectId: TENANT_A2.projectId,
            data: { receiptId: "batch-r1" },
          },
        ],
      }),
    });
    expect(eventMismatch.status).toBe(403);
    expect(await eventMismatch.json()).toMatchObject({ error: { code: "tenant-mismatch" } });

    const flatReceiptMismatch = await app.request("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        receipts: [{ ...validReceipt, orgId: TENANT_B.orgId }],
      }),
    });
    expect(flatReceiptMismatch.status).toBe(403);

    const nonStringDataOrg = await app.request("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "receipt.created",
            at: "2026-11-24T11:00:00.000Z",
            data: { orgId: 12345 },
          },
        ],
      }),
    });
    expect(nonStringDataOrg.status).toBe(403);

    expect(await stores.receipts.count(TENANT_A)).toBe(0);
    expect(await stores.metrics.count(TENANT_A)).toBe(0);
  });

  it("serialises concurrent same-idempotencyKey retries, rejects payload reuse with 409, and isolates tenants", async () => {
    const harness = await buildHarness();
    const { app, emitted } = harness;
    const batch = {
      idempotencyKey: "shared-batch-key",
      metrics: [
        {
          payer: "GA",
          payee: "GB",
          model: "x402",
          amount: "100",
          asset: ASSET,
          latencyMs: 4,
          outcome: "settled",
          at: "2026-11-24T11:00:00.000Z",
        },
      ],
      events: [
        {
          id: "evt-shared-1",
          type: "receipt.created",
          at: "2026-11-24T11:00:00.000Z",
          data: { note: "once" },
        },
      ],
    };

    const [c1, c2] = await Promise.all([
      app.request("/v1/ingest", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      }),
      app.request("/v1/ingest", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      }),
    ]);
    const bodies = await Promise.all([c1.json(), c2.json()]);
    expect(bodies.map((b) => b.deduplicated).sort()).toEqual([false, true]);
    expect(emitted).toHaveLength(1);

    // Reusing the same idempotencyKey with a different payload returns 409 conflict.
    const conflictReuse = await app.request("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({
        ...batch,
        metrics: [{ ...batch.metrics[0], amount: "999" }],
      }),
    });
    expect(conflictReuse.status).toBe(409);

    // Same idempotencyKey under tenant B is NOT treated as a duplicate of tenant A's batch.
    const firstB = await (
      await app.request("/v1/ingest", {
        method: "POST",
        headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      })
    ).json();
    expect(firstB).toMatchObject({ deduplicated: false, metrics: { accepted: 1 } });

    // Flooding tenant A's per-tenant idempotency ring past 1,000 keys never evicts tenant B's entry.
    for (let i = 0; i < 1_020; i += 1) {
      const flood = await app.request("/v1/ingest", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `flood-${i}`,
          events: [
            {
              type: "receipt.created",
              at: "2026-11-24T11:05:00.000Z",
              data: { seq: i },
            },
          ],
        }),
      });
      expect(flood.status).toBe(202);
    }

    const replayB = await (
      await app.request("/v1/ingest", {
        method: "POST",
        headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      })
    ).json();
    expect(replayB).toMatchObject({ deduplicated: true, metrics: { accepted: 1 } });

    const summaryA = await (
      await app.request("/v1/metrics/summary", { headers: bearer(KEY_A) })
    ).json();
    const summaryB = await (
      await app.request("/v1/metrics/summary", { headers: bearer(KEY_B) })
    ).json();
    expect(summaryA.count).toBe(1);
    expect(summaryB.count).toBe(1);
  });

  it("rejects conflicting receipt batches without partial writes and answers 503 when no verifier is configured", async () => {
    const harness = await buildHarness();
    const { app, signer, stores } = harness;

    const existing = await signReceipt(
      buildReceipt(receiptInput({ id: "atomic-conflict", amount: "100" })),
      signer,
    );
    expect(
      (
        await app.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [existing] }),
        })
      ).status,
    ).toBe(202);

    const freshFirst = await signReceipt(
      buildReceipt(receiptInput({ id: "atomic-fresh", amount: "200" })),
      signer,
    );
    const conflictingSecond = await signReceipt(
      buildReceipt(receiptInput({ id: "atomic-conflict", amount: "999" })),
      signer,
    );
    const batchConflict = await app.request("/v1/receipts", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({ receipts: [freshFirst, conflictingSecond] }),
    });
    expect(batchConflict.status).toBe(409);
    // All-or-nothing: freshFirst must NOT have been written before conflictingSecond failed.
    expect(await stores.receipts.get(TENANT_A, "atomic-fresh")).toBeUndefined();

    // Without a configured verifier, receipt writes return 503 not-ready.
    const unverifiedApp = createService({
      config: parseServiceConfig({
        env: {
          TOLLWAY_SERVICE_PORT: "8787",
          TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
            {
              name: "k1",
              ...TENANT_A,
              sha256: await hashApiKey(KEY_A),
              scopes: ["ingest"],
            },
          ]),
        },
      }),
      logger: captureLogger(),
      modules: [receiptsModule(), ingestModule()],
    });
    expect(
      (
        await unverifiedApp.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [freshFirst] }),
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await unverifiedApp.request("/v1/ingest", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [freshFirst] }),
        })
      ).status,
    ).toBe(503);
  });
});

describe("per-tenant quotas (429 responses), per-tenant observability, and operator admin path", () => {
  it("enforces per-tenant ingest rate and record caps with 429, allows duplicate receipts at full cap, and blocks idempotencyKey rate-limit bypass", async () => {
    let clockMs = Date.parse("2026-11-24T12:00:00.000Z");
    const verifySpy = vi.fn();
    const harness = await buildHarness({
      quotaClock: () => clockMs,
      quotas: {
        default: { maxIngestItemsPerMinute: 2, maxStoredRecords: 3 },
        tenants: [{ ...TENANT_B, maxIngestItemsPerMinute: 10, maxStoredRecords: 20 }],
      },
      verifierWrapper: (inner) => ({
        verify: async (sigInput) => {
          verifySpy();
          return inner.verify(sigInput);
        },
      }),
    });

    const { app, signer } = harness;
    const metricBody = (amount: string) => ({
      metrics: [
        {
          payer: "GA",
          payee: "GB",
          model: "x402" as const,
          amount,
          asset: ASSET,
          latencyMs: 5,
          outcome: "settled" as const,
          at: "2026-11-24T12:00:00.000Z",
        },
      ],
    });

    // Store 1 receipt and 1 metric in Tenant A (uses 2/2 rate limit, 2/3 stored records).
    const r1 = await signReceipt(buildReceipt(receiptInput({ id: "quota-r1" })), signer);
    expect(
      (
        await app.request("/v1/receipts", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ receipts: [r1] }),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await app.request("/v1/ingest", {
          method: "POST",
          headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
          body: JSON.stringify({ idempotencyKey: "rate-check", ...metricBody("10") }),
        })
      ).status,
    ).toBe(202);

    // Replaying the same idempotencyKey in the same minute STILL hits 429 rate-limited.
    const replayRateLimited = await app.request("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "rate-check", ...metricBody("10") }),
    });
    expect(replayRateLimited.status).toBe(429);
    expect(replayRateLimited.headers.get("Retry-After")).toBe("60");
    expect(await replayRateLimited.json()).toMatchObject({ error: { code: "rate-limited" } });

    // Tenant B has its own higher quota and is unaffected by Tenant A hitting 429.
    expect(
      (
        await app.request("/v1/metrics", {
          method: "POST",
          headers: { ...bearer(KEY_B), "Content-Type": "application/json" },
          body: JSON.stringify(metricBody("30")),
        })
      ).status,
    ).toBe(202);

    // Advance past the 60s window: Tenant A has 2/3 stored records.
    clockMs += 61_000;
    verifySpy.mockClear();

    // Concurrent single-item writes when 1 slot remains: serialized per-tenant lock admits 1 and rejects 1.
    const concurrent = await Promise.all([
      app.request("/v1/metrics", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify(metricBody("40")),
      }),
      app.request("/v1/metrics", {
        method: "POST",
        headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
        body: JSON.stringify(metricBody("50")),
      }),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([202, 429]);

    // Advance clock so rate window resets: Tenant A is now at 3/3 stored records (full).
    clockMs += 61_000;
    verifySpy.mockClear();

    // A brand-new receipt is rejected with 429 quota-exceeded BEFORE signature verification runs.
    const r2 = await signReceipt(buildReceipt(receiptInput({ id: "quota-r2" })), signer);
    const overStorage = await app.request("/v1/receipts", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({ receipts: [r2] }),
    });
    expect(overStorage.status).toBe(429);
    expect(await overStorage.json()).toMatchObject({ error: { code: "quota-exceeded" } });
    expect(verifySpy).not.toHaveBeenCalled();

    // Re-submitting an already-stored duplicate receipt adds 0 rows and succeeds with 202!
    const duplicateAtCap = await app.request("/v1/receipts", {
      method: "POST",
      headers: { ...bearer(KEY_A), "Content-Type": "application/json" },
      body: JSON.stringify({ receipts: [r1] }),
    });
    expect(duplicateAtCap.status).toBe(202);
    expect(await duplicateAtCap.json()).toEqual({ stored: 0, duplicates: 1 });
  });

  it("routes emitted events per tenant and supports createMemoryStores() with adminModule() and /readyz", async () => {
    const eventsA: TollwayEventInput[] = [];
    const eventsB: TollwayEventInput[] = [];
    const stores = createMemoryStores();
    const { forTenant } = deterministicAdapter();
    const channelManagers = createTenantChannelManagers({
      store: stores.channels,
      adapter: forTenant,
    });
    const config = parseServiceConfig({
      env: {
        TOLLWAY_SERVICE_PORT: "8787",
        TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
          {
            name: "alpha",
            ...TENANT_A,
            sha256: await hashApiKey(KEY_A),
            scopes: ["read", "ingest", "admin"],
          },
          {
            name: "bravo",
            ...TENANT_B,
            sha256: await hashApiKey(KEY_B),
            scopes: ["read", "ingest", "admin"],
          },
        ]),
        TOLLWAY_SERVICE_OPERATOR_KEYS: JSON.stringify([
          { name: "ops", sha256: await hashApiKey(KEY_OP) },
        ]),
      },
    });

    const app = createService({
      config,
      stores,
      logger: captureLogger(),
      channelManagers,
      observability: (tenant) => ({
        emit: async (event) => {
          if (tenant.orgId === TENANT_A.orgId) eventsA.push(event);
          else eventsB.push(event);
          return {
            event: { ...event, id: "e1" },
            handlersDispatched: 0,
            webhooksDispatched: 0,
            failures: [],
          };
        },
      }),
      modules: [createChannelsModule(), ingestModule(), adminModule()],
    });

    const chA = await channelManagers(TENANT_A).open({
      counterparty: "GP_A",
      asset: ASSET,
      deposit: "500",
      network: "testnet",
    });
    expect(
      (
        await app.request(`/v1/channels/${chA.id}/close`, {
          method: "POST",
          headers: bearer(KEY_A),
        })
      ).status,
    ).toBe(200);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);

    // Passing stores: createMemoryStores() automatically wires a working in-memory adminStore.
    const adminOverview = await app.request("/v1/admin/tenants", { headers: bearer(KEY_OP) });
    expect(adminOverview.status).toBe(200);
    expect(await adminOverview.json()).toEqual({
      tenants: [
        {
          ...TENANT_A,
          receipts: 0,
          metrics: 0,
          channels: 1,
          commitments: 0,
          policyVersions: 0,
          auditEntries: 1,
          totalRecords: 2,
        },
      ],
    });

    // A failing custom adminStore is surfaced by /readyz with 503.
    const failingAdminApp = createService({
      config,
      logger: captureLogger(),
      adminStore: {
        check: async () => {
          throw new Error("admin db offline");
        },
        listTenants: async () => [],
      },
    });
    const readyRes = await failingAdminApp.request("/readyz");
    expect(readyRes.status).toBe(503);
    expect((await readyRes.json()).error.details.stores.admin).toEqual({
      status: "failing",
      reason: "error",
    });
  });

  it("exposes cross-tenant counts only to operator keys through /v1/admin/tenants", async () => {
    const harness = await buildHarness();
    await seedTenantB(harness);

    const tenantAttempt = await harness.app.request("/v1/admin/tenants", {
      headers: bearer(KEY_B),
    });
    expect(tenantAttempt.status).toBe(403);

    const operatorAttemptOnTenantRoute = await harness.app.request("/v1/metrics/summary", {
      headers: bearer(KEY_OP),
    });
    expect(operatorAttemptOnTenantRoute.status).toBe(403);

    const operatorOverview = await harness.app.request("/v1/admin/tenants", {
      headers: bearer(KEY_OP),
    });
    expect(operatorOverview.status).toBe(200);
    const bodyText = await operatorOverview.text();
    expect(bodyText).not.toContain("GBRAVO");
    expect(JSON.parse(bodyText)).toEqual({
      tenants: [
        {
          ...TENANT_B,
          receipts: 2,
          metrics: 1,
          channels: 2,
          commitments: 2,
          policyVersions: 2,
          auditEntries: 2,
          totalRecords: 11,
        },
      ],
    });
  });
});

describe("Postgres composite keys and row-level security helpers", () => {
  it("puts (org_id, project_id) in every primary key, includes channel close-attempt columns, and forces RLS with operator read policy", () => {
    const sql = serviceTenantMigrations({ schema: "tollway", tablePrefix: "svc_" });
    const joined = sql.join(";\n");

    expect(joined).toContain("PRIMARY KEY (org_id, project_id, id)");
    expect(joined).toContain("PRIMARY KEY (org_id, project_id, position)");
    expect(joined).toContain("PRIMARY KEY (org_id, project_id, channel_id, sequence)");
    expect(joined).toContain("PRIMARY KEY (org_id, project_id, agent_id, version)");
    expect(joined).toContain("PRIMARY KEY (org_id, project_id, seq)");
    expect(joined).toContain("UNIQUE (org_id, project_id, id)");
    expect(joined).toContain("close_attempt_id TEXT");
    expect(joined).toContain("settlement_expected_amount NUMERIC(39, 0)");
    expect(joined).toContain("NULLIF(current_setting('tollway.org_id', true), '')");
    expect(joined).toContain("NULLIF(current_setting('tollway.project_id', true), '')");
    expect(joined).toContain("current_setting('tollway.operator_read', true) = 'on'");
    expect(sql.filter((stmt) => stmt.includes("ENABLE ROW LEVEL SECURITY"))).toHaveLength(6);
    expect(sql.filter((stmt) => stmt.includes("FORCE ROW LEVEL SECURITY"))).toHaveLength(6);

    expect(() => serviceTenantMigrations({ schema: "bad-schema; DROP TABLE x" })).toThrow(
      RangeError,
    );
  });

  it("binds transaction-local settings, destroys a broken pooled connection when ROLLBACK fails, and supports operator read-only rollups", async () => {
    const calls: Array<{ text: string; params?: readonly unknown[] }> = [];
    const releaseArgs: Array<boolean | undefined> = [];
    let failRollback = false;

    const client: PostgresPoolClient = {
      async query(text, params) {
        if (text === "ROLLBACK" && failRollback) {
          throw new Error("socket closed mid-rollback");
        }
        calls.push(params === undefined ? { text } : { text, params });
        return { rows: [{ ok: true }] };
      },
      release(destroy) {
        releaseArgs.push(destroy);
      },
    };
    const pool = {
      // A real pg.Pool also has .query; withTenantTransaction must still use .connect().
      query: vi.fn(async () => {
        throw new Error("pool.query must not be used for transaction-local RLS");
      }),
      connect: vi.fn(async () => client),
    };

    const value = await withTenantTransaction(pool, TENANT_A, async (tx) => {
      await tx.query("SELECT * FROM svc_receipts");
      return "done";
    });
    expect(value).toBe("done");
    expect(pool.query).not.toHaveBeenCalled();
    expect(releaseArgs).toEqual([false]);
    expect(calls).toEqual([
      { text: "BEGIN" },
      {
        text: "SELECT set_config('tollway.org_id', $1, true), set_config('tollway.project_id', $2, true)",
        params: [TENANT_A.orgId, TENANT_A.projectId],
      },
      { text: "SELECT * FROM svc_receipts" },
      { text: "COMMIT" },
    ]);

    calls.length = 0;
    releaseArgs.length = 0;
    failRollback = true;
    await expect(
      withTenantTransaction(pool, TENANT_B, async () => {
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    expect(releaseArgs).toEqual([true]);

    calls.length = 0;
    releaseArgs.length = 0;
    failRollback = false;
    await withOperatorReadTransaction(pool, async (tx) => {
      await tx.query("SELECT org_id, project_id, COUNT(*) FROM svc_receipts GROUP BY 1, 2");
    });
    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SELECT set_config('tollway.operator_read', 'on', true)",
      "SELECT org_id, project_id, COUNT(*) FROM svc_receipts GROUP BY 1, 2",
      "COMMIT",
    ]);
    expect(releaseArgs).toEqual([false]);
  });
});
