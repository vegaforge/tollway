import { createPolicyEngine, type Policy } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPolicyCache, fetchPolicy, PolicyFetchError } from "./policy-fetcher.js";

const VALID_POLICY: Policy = {
  policyVersion: 1,
  budgets: { daily: "1000000", total: "5000000" },
  perService: { "https://api.example.com": { cap: "500000" } },
};

describe("fetchPolicy", () => {
  it("loads the current policy on 200 and passes it to createPolicyEngine", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          agentId: "agent-1",
          version: 2,
          retired: false,
          policy: VALID_POLICY,
          createdAt: "2026-11-24T10:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json", ETag: '"2"' } },
      ),
    );

    const fetched = await fetchPolicy("https://service.test/", "agent-1", "secret-key", {
      fetch: fetcher,
      cache,
    });

    expect(fetched).toEqual({
      agentId: "agent-1",
      version: 2,
      etag: '"2"',
      policy: VALID_POLICY,
      createdAt: "2026-11-24T10:00:00.000Z",
      fromCache: false,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://service.test/v1/agents/agent-1/policy",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer secret-key" },
      }),
    );

    const engine = createPolicyEngine(fetched.policy);
    const decision = await engine.check({
      payee: "https://api.example.com",
      resource: "/v1/quote",
      amount: "100000",
      asset: "USDC:GA5Z",
      model: "x402",
    });
    expect(decision.allowed).toBe(true);
  });

  it("sends If-None-Match on subsequent calls and reuses the cached policy on 304", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            agentId: "agent-1",
            version: 3,
            retired: false,
            policy: VALID_POLICY,
            createdAt: "2026-11-24T10:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json", ETag: '"3"' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"3"' } }));

    const first = await fetchPolicy("https://service.test", "agent-1", "secret-key", {
      fetch: fetcher,
      cache,
    });
    const second = await fetchPolicy("https://service.test", "agent-1", "secret-key", {
      fetch: fetcher,
      cache,
    });

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.version).toBe(3);
    expect(second.policy).toEqual(VALID_POLICY);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://service.test/v1/agents/agent-1/policy",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer secret-key",
          "If-None-Match": '"3"',
        },
      }),
    );
  });

  it("throws PolicyFetchError with status 404 when no active policy exists", async () => {
    const cache = createMemoryPolicyCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not-found", message: "missing" } }), {
        status: 404,
      }),
    );

    await expect(
      fetchPolicy("https://service.test", "missing-agent", "secret-key", {
        fetch: fetcher,
        cache,
      }),
    ).rejects.toThrowError(PolicyFetchError);

    try {
      await fetchPolicy("https://service.test", "missing-agent", "secret-key", {
        fetch: fetcher,
        cache,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFetchError);
      expect((error as PolicyFetchError).status).toBe(404);
    }
  });
});
