import { type Policy, parsePolicy, TollwayError } from "@vegaforge/tollway-core";
import { z } from "zod";

/**
 * Fetches an agent's current policy from `@vegaforge/tollway-service` (#228),
 * sending `If-None-Match` when a cached ETag is present and reusing the cached
 * policy on `304 Not Modified`.
 */

/** One cached policy entry keyed by `(serviceUrl, agentId)`. */
export type CachedPolicyEntry = {
  agentId: string;
  version: number;
  etag: string;
  policy: Policy;
  createdAt: string;
};

/** Cache store used by {@link fetchPolicy} for `If-None-Match` conditional reads. */
export interface PolicyCache {
  get(key: string): CachedPolicyEntry | undefined;
  set(key: string, entry: CachedPolicyEntry): void;
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
  readonly status: number;

  constructor(status: number, message: string) {
    super("invalid-policy", message);
    this.name = "PolicyFetchError";
    this.status = status;
  }
}

const responseEnvelopeSchema = z.object({
  agentId: z.string().min(1),
  version: z.number().int().min(1),
  retired: z.boolean().optional(),
  policy: z.unknown(),
  createdAt: z.string().min(1),
});

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
  const cacheKey = `${url}::${agentId}`;
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
    return { ...cached, fromCache: true };
  }

  if (response.status === 404) {
    cache.delete(cacheKey);
    throw new PolicyFetchError(404, `no active policy found for agent "${agentId}"`);
  }

  if (!response.ok) {
    throw new PolicyFetchError(response.status, `policy fetch failed with HTTP ${response.status}`);
  }

  const envelope = responseEnvelopeSchema.safeParse(await response.json());
  if (!envelope.success || envelope.data.retired === true || envelope.data.policy === null) {
    throw new PolicyFetchError(response.status, "service returned an invalid policy envelope");
  }

  const parsed = parsePolicy(envelope.data.policy);
  if (!parsed.ok) {
    throw new PolicyFetchError(
      response.status,
      `service returned an invalid policy: ${parsed.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const etag = response.headers.get("etag") ?? `"${envelope.data.version}"`;
  const entry: CachedPolicyEntry = {
    agentId: envelope.data.agentId,
    version: envelope.data.version,
    etag,
    policy: parsed.policy,
    createdAt: envelope.data.createdAt,
  };
  cache.set(cacheKey, entry);

  return { ...entry, fromCache: false };
}
