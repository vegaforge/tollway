import { createPolicyEngine, type Policy } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPolicyCache, fetchPolicy, PolicyFetchError } from "./policy-fetcher.js";

const SERVICE = "https://service.test";
const VALID_POLICY: Policy = {
  policyVersion: 1,
  budgets: { daily: "1000000", total: "5000000" },
  perService: { "https://api.example.com": { cap: "500000" } },
};

/** The body `GET /v1/agents/{agentId}/policy` returns in @vegaforge/tollway-service. */
function policyResponse(
  version: number,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = { ETag: `"v${version}"` },
): Response {
  return new Response(
    JSON.stringify({
      orgId: "org-1",
      projectId: "proj-1",
      agentId: "agent-1",
      version,
      policy: VALID_POLICY,
      createdAt: "2026-11-24T10:00:00.000Z",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...headers } },
  );
}

async function rejection(promise: Promise<unknown>): Promise<PolicyFetchError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PolicyFetchError);
  return error as PolicyFetchError;
}

describe("fetchPolicy", () => {
  it("loads the current policy on 200 and passes it to createPolicyEngine", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(policyResponse(2));

    const fetched = await fetchPolicy(`${SERVICE}//`, "agent-1", "secret-key", {
      fetch: fetcher,
      cache: createMemoryPolicyCache(),
    });

    expect(fetched).toEqual({
      agentId: "agent-1",
      version: 2,
      etag: '"v2"',
      policy: VALID_POLICY,
      createdAt: "2026-11-24T10:00:00.000Z",
      fromCache: false,
    });
    expect(fetcher).toHaveBeenCalledWith(`${SERVICE}/v1/agents/agent-1/policy`, {
      method: "GET",
      headers: { Authorization: "Bearer secret-key" },
    });

    const decision = await createPolicyEngine(fetched.policy).check({
      payee: "https://api.example.com",
      resource: "/v1/quote",
      amount: "100000",
      asset: "USDC:GA5Z",
      model: "x402",
    });
    expect(decision.allowed).toBe(true);
  });

  it("sends If-None-Match on the next call and reuses the cached policy on 304", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse(3))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"v3"' } }));

    const first = await fetchPolicy(SERVICE, "agent-1", "secret-key", { fetch: fetcher, cache });
    const second = await fetchPolicy(SERVICE, "agent-1", "secret-key", { fetch: fetcher, cache });

    expect(first.fromCache).toBe(false);
    expect(second).toMatchObject({ fromCache: true, version: 3, policy: VALID_POLICY });
    expect(fetcher).toHaveBeenNthCalledWith(2, `${SERVICE}/v1/agents/agent-1/policy`, {
      method: "GET",
      headers: { Authorization: "Bearer secret-key", "If-None-Match": '"v3"' },
    });
  });

  it("hands out a copy, so a caller that mutates its policy cannot change the cache", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse(1))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    const first = await fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache });
    first.policy.budgets = { daily: "1" };
    const second = await fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache });

    expect(second.policy).toEqual(VALID_POLICY);
  });

  it("keeps one cache entry per API key, because each key belongs to its own tenant", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse(1))
      .mockResolvedValueOnce(
        policyResponse(1, {
          orgId: "org-2",
          policy: { policyVersion: 1, budgets: { daily: "7" } },
        }),
      );

    await fetchPolicy(SERVICE, "agent-1", "tenant-a-key", { fetch: fetcher, cache });
    const other = await fetchPolicy(SERVICE, "agent-1", "tenant-b-key", { fetch: fetcher, cache });

    // Tenant B must not send tenant A's ETag: version numbers repeat across
    // tenants, so a 304 would hand B tenant A's policy.
    expect(fetcher).toHaveBeenNthCalledWith(2, `${SERVICE}/v1/agents/agent-1/policy`, {
      method: "GET",
      headers: { Authorization: "Bearer tenant-b-key" },
    });
    expect(other.policy).toEqual({ policyVersion: 1, budgets: { daily: "7" } });
  });

  it("throws PolicyFetchError 404 and drops the cached copy when no active policy exists", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(policyResponse(1))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "not-found", message: "missing" } }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(policyResponse(4));

    await fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache });
    const error = await rejection(fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache }));
    expect(error.status).toBe(404);

    await fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache });
    expect(fetcher).toHaveBeenNthCalledWith(3, `${SERVICE}/v1/agents/agent-1/policy`, {
      method: "GET",
      headers: { Authorization: "Bearer k" },
    });
  });

  it("throws on any other non-2xx status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    const error = await rejection(
      fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache: createMemoryPolicyCache() }),
    );
    expect(error.status).toBe(503);
  });

  it("throws on 304 when nothing is cached", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }));
    const error = await rejection(
      fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache: createMemoryPolicyCache() }),
    );
    expect(error.status).toBe(304);
  });

  it.each([
    [
      "a policy that fails the core schema",
      () => policyResponse(1, { policy: { policyVersion: 1, budgets: { daily: "1.5" } } }),
    ],
    ["a retirement tombstone", () => policyResponse(1, { policy: null })],
    ["a different agent's policy", () => policyResponse(1, { agentId: "agent-2" })],
    ["a response without an ETag", () => policyResponse(1, {}, {})],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a version that is not a positive integer", () => policyResponse(1, { version: 0 })],
  ])("rejects %s and caches nothing", async (_label, response) => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response());

    const error = await rejection(fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache }));
    expect(error.status).toBe(200);
    expect(error.code).toBe("invalid-policy");

    fetcher.mockResolvedValueOnce(policyResponse(1));
    await fetchPolicy(SERVICE, "agent-1", "k", { fetch: fetcher, cache });
    expect(fetcher).toHaveBeenLastCalledWith(`${SERVICE}/v1/agents/agent-1/policy`, {
      method: "GET",
      headers: { Authorization: "Bearer k" },
    });
  });
});
