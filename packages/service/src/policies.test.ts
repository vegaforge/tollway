import type { Policy } from "@vegaforge/tollway-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenApiDocument } from "./openapi.js";
import { policyModule } from "./policies.js";
import { createMemoryPolicyStore } from "./stores.js";
import { bearer, KEYS, testService } from "./test-support.js";

function makeClock(startIso = "2026-11-24T12:00:00.000Z") {
  let ms = Date.parse(startIso);
  return () => {
    const current = ms;
    ms += 1000;
    return current;
  };
}

function adminJson(body: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    method: "PUT",
    headers: { ...bearer(KEYS.admin), "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function setupPolicyApp() {
  const policies = createMemoryPolicyStore({ clock: makeClock() });
  const { app } = await testService({
    stores: { policies },
    modules: [policyModule()],
  });
  return { app, policies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("policy store API", () => {
  it("creates, reads with ETag/304, updates with If-Match, lists versions, and retires via tombstone", async () => {
    const { app } = await setupPolicyApp();

    const v1Body: Policy = {
      policyVersion: 1,
      budgets: { daily: "1000", total: "5000" },
      perService: { "svc-a": { cap: "500" } },
    };

    // 1. Create v1
    const put1 = await app.request("/v1/agents/agent-1/policy", adminJson(v1Body));
    expect(put1.status).toBe(201);
    expect(put1.headers.get("etag")).toBe('"1"');
    const created = await put1.json();
    expect(created).toMatchObject({
      agentId: "agent-1",
      version: 1,
      retired: false,
      policy: v1Body,
    });

    // 2. Read current (200 + ETag) and conditional read (304)
    const get1 = await app.request("/v1/agents/agent-1/policy", { headers: bearer(KEYS.reader) });
    expect(get1.status).toBe(200);
    expect(get1.headers.get("etag")).toBe('"1"');
    expect(await get1.json()).toEqual(created);

    const get304 = await app.request("/v1/agents/agent-1/policy", {
      headers: { ...bearer(KEYS.reader), "If-None-Match": '"1"' },
    });
    expect(get304.status).toBe(304);
    expect(get304.headers.get("etag")).toBe('"1"');

    // 3. Stale or missing If-Match returns 412 without overwriting
    const missingIfMatch = await app.request(
      "/v1/agents/agent-1/policy",
      adminJson({ policyVersion: 1, budgets: { daily: "9999" } }),
    );
    expect(missingIfMatch.status).toBe(412);

    const staleIfMatch = await app.request(
      "/v1/agents/agent-1/policy",
      adminJson({ policyVersion: 1, budgets: { daily: "9999" } }, { "If-Match": '"99"' }),
    );
    expect(staleIfMatch.status).toBe(412);

    // 4. Update with matching If-Match -> v2
    const v2Body: Policy = {
      policyVersion: 1,
      budgets: { daily: "2000", total: "5000" },
      perService: { "svc-a": { cap: "500" }, "svc-b": { cap: "800" } },
      mode: "dry-run",
    };
    const put2 = await app.request(
      "/v1/agents/agent-1/policy",
      adminJson(v2Body, { "If-Match": '"1"' }),
    );
    expect(put2.status).toBe(200);
    expect(put2.headers.get("etag")).toBe('"2"');

    // 5. List versions & fetch specific immutable version
    const versionsRes = await app.request("/v1/agents/agent-1/policy/versions", {
      headers: bearer(KEYS.reader),
    });
    expect(versionsRes.status).toBe(200);
    const versionsJson = await versionsRes.json();
    expect(versionsJson.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);

    const v1Res = await app.request("/v1/agents/agent-1/policy/versions/1", {
      headers: bearer(KEYS.reader),
    });
    expect(v1Res.status).toBe(200);
    expect((await v1Res.json()).policy).toEqual(v1Body);

    // 6. Retire via DELETE -> tombstone v3, history stays intact, GET current -> 404
    const delRes = await app.request("/v1/agents/agent-1/policy", {
      method: "DELETE",
      headers: { ...bearer(KEYS.admin), "If-Match": '"2"' },
    });
    expect(delRes.status).toBe(200);
    expect(delRes.headers.get("etag")).toBe('"3"');
    expect(await delRes.json()).toMatchObject({
      agentId: "agent-1",
      version: 3,
      retired: true,
      policy: null,
    });

    const afterRetireGet = await app.request("/v1/agents/agent-1/policy", {
      headers: bearer(KEYS.reader),
    });
    expect(afterRetireGet.status).toBe(404);

    const versionsAfterRetire = await app.request("/v1/agents/agent-1/policy/versions", {
      headers: bearer(KEYS.reader),
    });
    expect((await versionsAfterRetire.json()).versions).toHaveLength(3);
  });

  it("returns 422 with zod issue paths when policy validation fails", async () => {
    const { app } = await setupPolicyApp();

    const invalid = {
      policyVersion: 1,
      budgets: { daily: "12.34", unknownField: "1" },
      rateLimit: { requestsPerMinute: -5 },
    };
    const res = await app.request("/v1/agents/agent-bad/policy", adminJson(invalid));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid-policy");
    const paths = (body.error.details.issues as Array<{ path: string[] }>).map((i) =>
      i.path.join("."),
    );
    expect(paths).toContain("budgets.daily");
    expect(paths).toContain("budgets.unknownField");
    expect(paths).toContain("rateLimit.requestsPerMinute");
  });

  it("enforces read and admin scopes and validates agentId charset", async () => {
    const { app } = await setupPolicyApp();

    const readPut = await app.request("/v1/agents/agent-1/policy", {
      method: "PUT",
      headers: { ...bearer(KEYS.reader), "Content-Type": "application/json" },
      body: JSON.stringify({ policyVersion: 1 }),
    });
    expect(readPut.status).toBe(403);

    const badAgentId = await app.request("/v1/agents/bad%20agent!/policy", {
      headers: bearer(KEYS.reader),
    });
    expect(badAgentId.status).toBe(400);
  });

  it("records ordered immutable audit entries with structural diffs and cursor pagination", async () => {
    const { app } = await setupPolicyApp();

    await app.request(
      "/v1/agents/agent-a/policy",
      adminJson({ policyVersion: 1, budgets: { daily: "100" } }),
    );
    await app.request("/v1/agents/agent-b/policy", adminJson({ policyVersion: 1 }));
    await app.request(
      "/v1/agents/agent-a/policy",
      adminJson(
        { policyVersion: 1, budgets: { daily: "250", total: "1000" } },
        { "If-Match": '"1"' },
      ),
    );
    await app.request("/v1/agents/agent-a/policy", {
      method: "DELETE",
      headers: bearer(KEYS.admin),
    });

    // Cursor pagination over all audit records (newest first)
    const page1 = await app.request("/v1/audit?limit=2", { headers: bearer(KEYS.reader) });
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.entries).toHaveLength(2);
    expect(body1.entries.map((e: { sequence: number }) => e.sequence)).toEqual([4, 3]);
    expect(body1.nextCursor).toBeTypeOf("string");

    const page2 = await app.request(
      `/v1/audit?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      {
        headers: bearer(KEYS.reader),
      },
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.entries.map((e: { sequence: number }) => e.sequence)).toEqual([2, 1]);
    expect(body2.nextCursor).toBeUndefined();

    // Filter by agentId and inspect structural diffs
    const agentAAudit = await app.request("/v1/audit?agentId=agent-a", {
      headers: bearer(KEYS.reader),
    });
    const agentABody = await agentAAudit.json();
    expect(agentABody.entries).toHaveLength(3);
    expect(agentABody.entries.map((e: { action: string }) => e.action)).toEqual([
      "retire",
      "update",
      "create",
    ]);
    expect(agentABody.entries[1]).toMatchObject({
      agentId: "agent-a",
      version: 2,
      actor: "admin",
      diff: [
        { path: "budgets.daily", op: "replace", before: "100", after: "250" },
        { path: "budgets.total", op: "add", after: "1000" },
      ],
    });

    // Audit records cannot be edited or deleted through the API
    const patchAudit = await app.request("/v1/audit", {
      method: "PATCH",
      headers: bearer(KEYS.admin),
    });
    expect(patchAudit.status).toBe(404);

    const deleteAudit = await app.request("/v1/audit", {
      method: "DELETE",
      headers: bearer(KEYS.admin),
    });
    expect(deleteAudit.status).toBe(404);
  });

  it("publishes all policy and audit routes in /openapi.json and makes no outbound fetch calls", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("outbound fetch forbidden");
    });

    const { app } = await setupPolicyApp();
    const docRes = await app.request("/openapi.json");
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as OpenApiDocument;
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/v1/agents/{agentId}/policy",
        "/v1/agents/{agentId}/policy/versions",
        "/v1/agents/{agentId}/policy/versions/{version}",
        "/v1/audit",
      ]),
    );

    const putRes = await app.request(
      "/v1/agents/agent-offline/policy",
      adminJson({ policyVersion: 1 }),
    );
    expect(putRes.status).toBe(201);
  });

  it("property: any sequence of accepted updates yields strictly increasing versions and one audit record per version", async () => {
    let seed = 0x2280beef;
    const nextRand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let run = 0; run < 25; run += 1) {
      const { app } = await setupPolicyApp();
      let knownVersion: number | null = null;
      let isRetired = false;
      const acceptedVersions: number[] = [];

      for (let step = 0; step < 12; step += 1) {
        const roll = nextRand();
        if (roll < 0.25 && knownVersion !== null && !isRetired) {
          // Retire attempt (sometimes with stale If-Match)
          const useStale = nextRand() < 0.3;
          const ifMatch = useStale ? `"${knownVersion + 5}"` : `"${knownVersion}"`;
          const res = await app.request("/v1/agents/prop-agent/policy", {
            method: "DELETE",
            headers: { ...bearer(KEYS.admin), "If-Match": ifMatch },
          });
          if (useStale) {
            expect(res.status).toBe(412);
          } else {
            expect(res.status).toBe(200);
            const json = await res.json();
            knownVersion = json.version;
            isRetired = true;
            acceptedVersions.push(json.version);
          }
        } else {
          // PUT attempt (sometimes invalid policy, sometimes stale If-Match)
          const sendInvalid = nextRand() < 0.2;
          const useStale = !sendInvalid && knownVersion !== null && nextRand() < 0.3;
          const body = sendInvalid
            ? { policyVersion: 1, budgets: { daily: "not-int" } }
            : { policyVersion: 1, budgets: { daily: String((step + 1) * 100) } };
          const headers: Record<string, string> = {};
          if (knownVersion !== null) {
            headers["If-Match"] = useStale ? `"${knownVersion + 9}"` : `"${knownVersion}"`;
          }
          const res = await app.request("/v1/agents/prop-agent/policy", adminJson(body, headers));
          if (sendInvalid) {
            expect(res.status).toBe(422);
          } else if (useStale) {
            expect(res.status).toBe(412);
          } else {
            expect(res.status).toBe(knownVersion === null ? 201 : 200);
            const json = await res.json();
            knownVersion = json.version;
            isRetired = false;
            acceptedVersions.push(json.version);
          }
        }
      }

      // Strictly increasing versions 1..N
      expect(acceptedVersions).toEqual(acceptedVersions.map((_, idx) => idx + 1));

      const versionsRes = await app.request("/v1/agents/prop-agent/policy/versions", {
        headers: bearer(KEYS.reader),
      });
      const storedVersions = (await versionsRes.json()).versions as Array<{ version: number }>;
      expect(storedVersions.map((v) => v.version)).toEqual(acceptedVersions);

      const auditRes = await app.request("/v1/audit?agentId=prop-agent&limit=200", {
        headers: bearer(KEYS.reader),
      });
      const auditEntries = (await auditRes.json()).entries as Array<{ version: number }>;
      expect(auditEntries.map((e) => e.version).reverse()).toEqual(acceptedVersions);
    }
  });
});
