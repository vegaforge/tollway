import {
  formatPolicyIssues,
  type Policy,
  parsePolicy,
  TollwayError,
} from "@vegaforge/tollway-core";
import { z } from "zod";

/**
 * Fetches an agent's current policy from `@vegaforge/tollway-service` (#228),
 * sending `If-None-Match` when a cached ETag is present and reusing the cached
 * policy on `304 Not Modified`.
 */

/**
 * One cached policy entry. Entries are keyed by the policy URL and a SHA-256
 * digest of the API key: each key belongs to one tenant, and version numbers
 * (so ETags) repeat across tenants.
 */
export type CachedPolicyEntry = {
  agentId: string;
  version: number;
  etag: string;
  policy: Policy;
  createdAt: string;
};

/** Cache store used by {@link fetchPolicy} for `If-None-Match` conditional reads. */
export interface PolicyCache {
  /** The entry stored under `key`, or `undefined`. */
  get(key: string): CachedPolicyEntry | undefined;
  /** Stores `entry` under `key`, replacing any earlier entry. */
  set(key: string, entry: CachedPolicyEntry): void;
  /** Removes the entry under `key`; used when the service reports no active policy. */
  delete(key: string): void;
}

/** Creates an isolated in-memory {@link PolicyCache}. */
export function createMemoryPolicyCache(): PolicyCache {
  const entries = new Map<string, CachedPolicyEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.set(key, entry);
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}

const defaultPolicyCache = createMemoryPolicyCache();

/** Options for {@link fetchPolicy}. */
export type FetchPolicyOptions = {
  /** Custom `fetch` implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Conditional-request cache; defaults to a shared in-memory cache. */
  cache?: PolicyCache;
};

/** Policy loaded from `@vegaforge/tollway-service`, ready for `createPolicyEngine`. */
export type FetchedPolicy = CachedPolicyEntry & {
  /** `true` when the service answered `304 Not Modified` and the cached copy was reused. */
  fromCache: boolean;
};

/** Error thrown when {@link fetchPolicy} cannot load an active policy. */
export class PolicyFetchError extends TollwayError {
  /** HTTP status of the response that failed. */
  readonly status: number;

  constructor(status: number, message: string) {
    super("invalid-policy", message);
    this.name = "PolicyFetchError";
    this.status = status;
  }
}

// The service's `policyVersionResponseSchema`. `policy` is checked separately
// with `parsePolicy` so its issues can be reported by path.
const responseEnvelopeSchema = z.object({
  agentId: z.string().min(1),
  version: z.number().int().min(1),
  policy: z.unknown(),
  createdAt: z.string().min(1),
});

function invalidResponse(status: number, reason: string): PolicyFetchError {
  return new PolicyFetchError(status, `service returned an invalid policy response: ${reason}`);
}

async function cacheKeyFor(url: string, apiKey: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `${url} ${hex.join("")}`;
}

function copyOf(entry: CachedPolicyEntry, fromCache: boolean): FetchedPolicy {
  return { ...structuredClone(entry), fromCache };
}

function policyEndpointUrl(serviceUrl: string, agentId: string): string {
  let end = serviceUrl.length;
  while (end > 0 && serviceUrl.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  const base = serviceUrl.slice(0, end);
  return `${base}/v1/agents/${encodeURIComponent(agentId)}/policy`;
}

/**
 * Loads the active policy for `agentId` from `serviceUrl` using `apiKey`.
 * Sends `If-None-Match` when a cached copy exists, reuses the cached policy on
 * `304 Not Modified`, and validates `200` payloads with `parsePolicy` so the
 * returned `policy` can be passed straight to `createPolicyEngine`.
 */
export async function fetchPolicy(
  serviceUrl: string,
  agentId: string,
  apiKey: string,
  options: FetchPolicyOptions = {},
): Promise<FetchedPolicy> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const cache = options.cache ?? defaultPolicyCache;
  const url = policyEndpointUrl(serviceUrl, agentId);
  const cacheKey = await cacheKeyFor(url, apiKey);
  const cached = cache.get(cacheKey);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (cached !== undefined) {
    headers["If-None-Match"] = cached.etag;
  }

  const response = await fetcher(url, { method: "GET", headers });

  if (response.status === 304) {
    if (cached === undefined) {
      throw new PolicyFetchError(304, "service returned 304 Not Modified with no cached policy");
    }
    return copyOf(cached, true);
  }

  if (response.status === 404) {
    cache.delete(cacheKey);
    throw new PolicyFetchError(404, `no active policy found for agent "${agentId}"`);
  }

  if (!response.ok) {
    throw new PolicyFetchError(response.status, `policy fetch failed with HTTP ${response.status}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw invalidResponse(response.status, "the body is not JSON");
  }
  const envelope = responseEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw invalidResponse(response.status, "the body does not match the policy response shape");
  }
  if (envelope.data.agentId !== agentId) {
    throw invalidResponse(response.status, `it is for agent "${envelope.data.agentId}"`);
  }
  if (envelope.data.policy === null) {
    throw invalidResponse(response.status, "the policy is retired");
  }
  const parsed = parsePolicy(envelope.data.policy);
  if (!parsed.ok) {
    throw invalidResponse(
      response.status,
      formatPolicyIssues(parsed.issues).replaceAll("\n", "; "),
    );
  }
  // The ETag is what makes the next request conditional. Without one there
  // is nothing safe to cache, and inventing one could match the wrong version.
  const etag = response.headers.get("ETag");
  if (etag === null || etag.length === 0) {
    throw invalidResponse(response.status, "it has no ETag header");
  }

  const entry: CachedPolicyEntry = {
    agentId: envelope.data.agentId,
    version: envelope.data.version,
    etag,
    policy: parsed.policy,
    createdAt: envelope.data.createdAt,
  };
  cache.set(cacheKey, entry);
  return copyOf(entry, false);
}
