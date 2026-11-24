import type { Policy } from "@vegaforge/tollway-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenApiDocument } from "./openapi.js";
import { policiesModule } from "./policies.js";
import { createMemoryAuditStore, createMemoryPolicyStore } from "./stores.js";
import { bearer, DEFAULT_TENANT, KEYS, testService } from "./test-support.js";

// Every test here runs inside one tenant (DEFAULT_TENANT). Cross-tenant
// isolation of the same routes is covered in isolation.test.ts.

const POLICY_PATH = "/v1/agents/agent-1/policy";

function makeClock(startIso = "2026-11-24T12:00:00.000Z") {
  let ms = Date.parse(startIso);
  return () => {
    const current = ms;
    ms += 1000;
    return current;
  };
}

function put(body: unknown, extraHeaders: Record<string, string> = {}, key: string = KEYS.admin) {
  return {
    method: "PUT",
    headers: { ...bearer(key), "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function del(extraHeaders: Record<string, string> = {}, key: string = KEYS.admin) {
  return { method: "DELETE", headers: { ...bearer(key), ...extraHeaders } };
}

const read = { headers: bearer(KEYS.reader) };

async function setup() {
  const policies = createMemoryPolicyStore({ clock: makeClock() });
  const audit = createMemoryAuditStore({ clock: makeClock() });
  const { app } = await testService({
    stores: { policies, audit },
    modules: [policiesModule()],
  });
  return { app, policies, audit };
}

const V1: Policy = {
  policyVersion: 1,
  budgets: { daily: "1000", total: "5000" },
  perService: { "svc-a": { cap: "500" } },
};

const V2: Policy = {
  policyVersion: 1,
  mode: "dry-run",
  budgets: { daily: "2000", total: "5000" },
  perService: { "svc-a": { cap: "500" }, "svc-b": { cap: "800" } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PUT /v1/agents/{agentId}/policy", () => {
  it("takes the policy document as the body and stores version 1 with an ETag", async () => {
    const { app } = await setup();

    const res = await app.request(POLICY_PATH, put(V1));

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(await res.json()).toEqual({
      ...DEFAULT_TENANT,
      agentId: "agent-1",
      version: 1,
      policy: V1,
      createdAt: "2026-11-24T12:00:00.000Z",
    });
  });

  it("refuses a create that carries If-Match, because no version exists to match", async () => {
    const { app } = await setup();

    const res = await app.request(POLICY_PATH, put(V1, { "If-Match": '"v1"' }));

    expect(res.status).toBe(412);
    expect((await res.json()).error.code).toBe("precondition-failed");
    expect((await app.request(POLICY_PATH, read)).status).toBe(404);
  });

  it("requires If-Match with the current version for an update and returns 412 when it is missing or stale", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));

    const missing = await app.request(POLICY_PATH, put(V2));
    expect(missing.status).toBe(412);
    expect(await missing.json()).toMatchObject({
      error: { code: "precondition-failed", details: { currentVersion: 1 } },
    });

    for (const stale of ['"v9"', '"1"', 'W/"v1"', "*", '"v1", "v2"']) {
      const res = await app.request(POLICY_PATH, put(V2, { "If-Match": stale }));
      expect(res.status, `If-Match: ${stale}`).toBe(412);
    }

    // Nothing was overwritten.
    const current = await app.request(POLICY_PATH, read);
    expect((await current.json()).policy).toEqual(V1);

    const ok = await app.request(POLICY_PATH, put(V2, { "If-Match": '"v1"' }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"v2"');
    expect(await ok.json()).toMatchObject({ version: 2, policy: V2 });
  });

  it("lets exactly one of two concurrent updates with the same If-Match win (compare-and-set)", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));

    const [first, second] = await Promise.all([
      app.request(POLICY_PATH, put({ ...V1, budgets: { daily: "111" } }, { "If-Match": '"v1"' })),
      app.request(POLICY_PATH, put({ ...V1, budgets: { daily: "222" } }, { "If-Match": '"v1"' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 412]);
    const versions = await (await app.request(`${POLICY_PATH}/versions`, read)).json();
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    const audit = await (await app.request("/v1/audit?agentId=agent-1", read)).json();
    expect(audit.entries).toHaveLength(2);
  });

  it("returns 422 invalid-policy with the zod issue paths when validation fails", async () => {
    const { app } = await setup();

    const res = await app.request(
      "/v1/agents/agent-bad/policy",
      put({
        policyVersion: 1,
        budgets: { daily: "12.34", unknownField: "1" },
        rateLimit: { requestsPerMinute: -5 },
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid-policy");
    const paths = (body.error.details.issues as Array<{ path: Array<string | number> }>).map((i) =>
      i.path.join("."),
    );
    expect(paths).toContain("budgets.daily");
    expect(paths).toContain("budgets.unknownField");
    expect(paths).toContain("rateLimit.requestsPerMinute");
    expect((await app.request("/v1/audit", read)).status).toBe(200);
    expect((await (await app.request("/v1/audit", read)).json()).entries).toEqual([]);
  });

  it("rejects a non-integer or negative amount and an injected tenant field with 422", async () => {
    const { app } = await setup();

    for (const body of [
      { policyVersion: 1, budgets: { total: "1e6" } },
      { policyVersion: 1, budgets: { total: "-5" } },
      { policyVersion: 1, perService: { s: { cap: "0.5" } } },
      { ...V1, orgId: "someone-else" },
      { policy: V1, expectedVersion: null },
    ]) {
      const res = await app.request(POLICY_PATH, put(body));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("needs the admin scope and validates the agent id", async () => {
    const { app } = await setup();

    expect((await app.request(POLICY_PATH, put(V1, {}, KEYS.reader))).status).toBe(403);
    expect((await app.request("/v1/agents/bad%20agent!/policy", read)).status).toBe(400);
    expect((await app.request(`/v1/agents/${"a".repeat(65)}/policy`, read)).status).toBe(400);
  });
});

describe("GET /v1/agents/{agentId}/policy", () => {
  it("returns the current version with an ETag and answers If-None-Match with 304", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));

    const res = await app.request(POLICY_PATH, read);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(await res.json()).toMatchObject({ version: 1, policy: V1 });

    for (const tag of ['"v1"', 'W/"v1"', '"v7", "v1"', "*"]) {
      const cached = await app.request(POLICY_PATH, {
        headers: { ...bearer(KEYS.reader), "If-None-Match": tag },
      });
      expect(cached.status, `If-None-Match: ${tag}`).toBe(304);
      expect(cached.headers.get("etag")).toBe('"v1"');
      expect(await cached.text()).toBe("");
    }

    const changed = await app.request(POLICY_PATH, {
      headers: { ...bearer(KEYS.reader), "If-None-Match": '"v0"' },
    });
    expect(changed.status).toBe(200);
  });

  it("returns 404 for an agent with no policy", async () => {
    const { app } = await setup();
    expect((await app.request(POLICY_PATH, read)).status).toBe(404);
  });
});

describe("policy versions", () => {
  it("lists every version and returns one by number", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));
    await app.request(POLICY_PATH, put(V2, { "If-Match": '"v1"' }));

    const list = await app.request(`${POLICY_PATH}/versions`, read);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);

    const one = await app.request(`${POLICY_PATH}/versions/1`, read);
    expect(one.status).toBe(200);
    expect(one.headers.get("etag")).toBe('"v1"');
    expect(await one.json()).toMatchObject({ ...DEFAULT_TENANT, version: 1, policy: V1 });

    expect((await app.request(`${POLICY_PATH}/versions/3`, read)).status).toBe(404);
    expect((await app.request(`${POLICY_PATH}/versions/0`, read)).status).toBe(400);
    expect((await app.request(`${POLICY_PATH}/versions/1.5`, read)).status).toBe(400);
    expect((await app.request("/v1/agents/nobody/policy/versions/1", read)).status).toBe(404);
  });
});

describe("DELETE /v1/agents/{agentId}/policy", () => {
  it("retires with a tombstone version, keeps history, and needs If-Match", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));
    await app.request(POLICY_PATH, put(V2, { "If-Match": '"v1"' }));

    expect((await app.request(POLICY_PATH, del({}, KEYS.reader))).status).toBe(403);
    expect((await app.request(POLICY_PATH, del())).status).toBe(412);
    expect((await app.request(POLICY_PATH, del({ "If-Match": '"v1"' }))).status).toBe(412);

    const retired = await app.request(POLICY_PATH, del({ "If-Match": '"v2"' }));
    expect(retired.status).toBe(200);
    expect(retired.headers.get("etag")).toBe('"v3"');
    expect(await retired.json()).toMatchObject({ version: 3, policy: null });

    // No active policy, but every version is still readable.
    expect((await app.request(POLICY_PATH, read)).status).toBe(404);
    const versions = await (await app.request(`${POLICY_PATH}/versions`, read)).json();
    expect(versions.versions.map((v: { policy: unknown }) => v.policy)).toEqual([V1, V2, null]);
    expect(await (await app.request(`${POLICY_PATH}/versions/1`, read)).json()).toMatchObject({
      policy: V1,
    });

    // Retiring twice is a 404: there is nothing active to retire.
    expect((await app.request(POLICY_PATH, del({ "If-Match": '"v3"' }))).status).toBe(404);

    // A later PUT starts a new active version on top of the tombstone, guarded by its ETag.
    expect((await app.request(POLICY_PATH, put(V1))).status).toBe(412);
    const revived = await app.request(POLICY_PATH, put(V1, { "If-Match": '"v3"' }));
    expect(revived.status).toBe(200);
    expect(await revived.json()).toMatchObject({ version: 4, policy: V1 });
  });

  it("returns 404 for an agent that never had a policy", async () => {
    const { app } = await setup();
    expect((await app.request(POLICY_PATH, del({ "If-Match": '"v1"' }))).status).toBe(404);
  });
});

describe("GET /v1/audit", () => {
  it("records one entry per change with actor, version and a structural diff, newest first and paged", async () => {
    const { app } = await setup();
    await app.request(
      "/v1/agents/agent-a/policy",
      put({ policyVersion: 1, budgets: { daily: "100" } }),
    );
    await app.request("/v1/agents/agent-b/policy", put({ policyVersion: 1 }));
    await app.request(
      "/v1/agents/agent-a/policy",
      put({ policyVersion: 1, budgets: { daily: "250", total: "1000" } }, { "If-Match": '"v1"' }),
    );
    await app.request("/v1/agents/agent-a/policy", del({ "If-Match": '"v2"' }));

    const page1 = await (await app.request("/v1/audit?limit=2", read)).json();
    expect(
      page1.entries.map((e: { agentId: string; version: number }) => [e.agentId, e.version]),
    ).toEqual([
      ["agent-a", 3],
      ["agent-a", 2],
    ]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await (
      await app.request(`/v1/audit?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, read)
    ).json();
    expect(
      page2.entries.map((e: { agentId: string; version: number }) => [e.agentId, e.version]),
    ).toEqual([
      ["agent-b", 1],
      ["agent-a", 1],
    ]);
    expect(page2.nextCursor).toBeUndefined();

    const agentA = await (await app.request("/v1/audit?agentId=agent-a", read)).json();
    expect(agentA.entries.map((e: { action: string }) => e.action)).toEqual([
      "policy.retired",
      "policy.updated",
      "policy.created",
    ]);
    expect(agentA.entries[1]).toMatchObject({
      ...DEFAULT_TENANT,
      agentId: "agent-a",
      version: 2,
      actorKey: "admin",
      changes: [
        { path: "budgets.daily", before: "100", after: "250" },
        { path: "budgets.total", after: "1000" },
      ],
    });
    expect(agentA.entries[0].changes).toEqual([
      {
        path: "$",
        before: { policyVersion: 1, budgets: { daily: "250", total: "1000" } },
        after: null,
      },
    ]);
  });

  it("has no route that edits or deletes an audit entry", async () => {
    const { app } = await setup();
    await app.request(POLICY_PATH, put(V1));

    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const res = await app.request("/v1/audit", { method, headers: bearer(KEYS.admin) });
      expect(res.status, method).toBe(404);
    }
    const doc = (await (await app.request("/openapi.json")).json()) as OpenApiDocument;
    expect(Object.keys(doc.paths["/v1/audit"] ?? {})).toEqual(["get"]);
  });
});

describe("policy routes in /openapi.json", () => {
  it("publishes every policy operation and makes no outbound fetch", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("outbound fetch forbidden");
    });
    const { app } = await setup();

    const doc = (await (await app.request("/openapi.json")).json()) as OpenApiDocument;
    const operations = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith("/v1/"))
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(operations).toEqual([
      "DELETE /v1/agents/{agentId}/policy",
      "GET /v1/agents/{agentId}/policy",
      "GET /v1/agents/{agentId}/policy/versions",
      "GET /v1/agents/{agentId}/policy/versions/{version}",
      "GET /v1/audit",
      "GET /v1/whoami",
      "PUT /v1/agents/{agentId}/policy",
    ]);
    expect((await app.request(POLICY_PATH, put(V1))).status).toBe(200);
  });
});

describe("property: accepted changes and the audit trail", () => {
  it("any sequence of accepted updates yields strictly increasing versions and one audit entry per version", async () => {
    // Deterministic mulberry32 so a failure reproduces.
    let seed = 0x2280beef;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let run = 0; run < 25; run += 1) {
      const { app } = await setup();
      let latest: number | null = null;
      let active = false;
      const accepted: number[] = [];

      for (let step = 0; step < 12; step += 1) {
        const stale = latest !== null && next() < 0.3;
        const ifMatch: Record<string, string> =
          latest === null ? {} : { "If-Match": `"v${stale ? latest + 7 : latest}"` };

        if (active && next() < 0.25) {
          const res = await app.request(POLICY_PATH, del(ifMatch));
          expect(res.status).toBe(stale ? 412 : 200);
          if (!stale) {
            latest = (await res.json()).version as number;
            active = false;
            accepted.push(latest);
          }
          continue;
        }

        const invalid = next() < 0.2;
        const body = invalid
          ? { policyVersion: 1, budgets: { daily: "not-an-integer" } }
          : { policyVersion: 1, budgets: { daily: String((step + 1) * 100) } };
        const res = await app.request(POLICY_PATH, put(body, ifMatch));
        if (invalid) {
          expect(res.status).toBe(422);
        } else if (stale) {
          expect(res.status).toBe(412);
        } else {
          expect(res.status).toBe(200);
          latest = (await res.json()).version as number;
          active = true;
          accepted.push(latest);
        }
      }

      expect(accepted).toEqual(accepted.map((_, index) => index + 1));
      const stored = (await (await app.request(`${POLICY_PATH}/versions`, read)).json()) as {
        versions?: Array<{ version: number }>;
      };
      expect((stored.versions ?? []).map((v) => v.version)).toEqual(accepted);
      const audit = (await (await app.request("/v1/audit?agentId=agent-1&limit=200", read)).json())
        .entries as Array<{ version: number }>;
      expect(audit.map((e) => e.version).reverse()).toEqual(accepted);
    }
  });
});
