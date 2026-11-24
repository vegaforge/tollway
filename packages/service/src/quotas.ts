import type { QuotasConfig, TenantQuota } from "./config.js";
import { type ErrorBody, errorBody } from "./errors.js";
import type { ServiceStores } from "./stores.js";
import { type TenantScope, tenantPartitionKey } from "./tenancy.js";

/**
 * Per-tenant ingest rate and stored-record quotas (#231).
 *
 * Writes within one `(orgId, projectId)` partition acquire a per-tenant async
 * gate held until the store write completes (`release()`), eliminating TOCTOU
 * oversells across concurrent requests while keeping distinct tenants lock-free
 * with respect to one another.
 */

const WINDOW_MS = 60_000;
const STORAGE_RETRY_AFTER_SECONDS = 60;

type IngestSample = {
  atMs: number;
  count: number;
};

/** Outcome of checking per-tenant rate and record-count quotas before a write. */
export type QuotaCheckOutcome =
  | {
      allowed: true;
      /** Releases the per-tenant write gate once the store mutation finishes or aborts. */
      release: () => void;
    }
  | {
      allowed: false;
      status: 429;
      retryAfterSeconds: number;
      body: ErrorBody;
    };

/** Resource counts requested by an incoming tenant write. */
export type QuotaRequest = {
  /** Number of items arriving on an ingest endpoint (checked against `maxIngestItemsPerMinute`). */
  ingestItems?: number;
  /**
   * Count of net-new rows this write will add (checked against `maxStoredRecords`),
   * or an async callback evaluated inside the per-tenant lock after rate limits pass.
   */
  newStoredRecords?: number | (() => Promise<number>);
};

/** Evaluates and serialises per-tenant ingest rate and storage caps. */
export interface QuotaEnforcer {
  /** Checks `request` against `tenant`'s configured quotas and holds the tenant gate until `release()`. */
  acquire(tenant: TenantScope, request: QuotaRequest): Promise<QuotaCheckOutcome>;
}

async function countTenantRecords(stores: ServiceStores, tenant: TenantScope): Promise<number> {
  const [receipts, metrics, channels, policies, audit] = await Promise.all([
    stores.receipts.count(tenant),
    stores.metrics.count(tenant),
    stores.channels.count(tenant),
    stores.policies.count(tenant),
    stores.audit.count(tenant),
  ]);
  return receipts + metrics + channels + policies + audit;
}

/** Options passed to {@link createQuotaEnforcer}. */
export type CreateQuotaEnforcerOptions = {
  quotas?: QuotasConfig | undefined;
  stores: ServiceStores;
  now?: () => number;
};

/** Creates a {@link QuotaEnforcer} over the configured tenant limits and backing stores. */
export function createQuotaEnforcer(options: CreateQuotaEnforcerOptions): QuotaEnforcer {
  const { quotas, stores } = options;
  const now = options.now ?? Date.now;

  const overrides = new Map<string, TenantQuota>();
  for (const entry of quotas?.tenants ?? []) {
    const quota: TenantQuota = {
      ...(entry.maxIngestItemsPerMinute === undefined
        ? {}
        : { maxIngestItemsPerMinute: entry.maxIngestItemsPerMinute }),
      ...(entry.maxStoredRecords === undefined ? {} : { maxStoredRecords: entry.maxStoredRecords }),
    };
    overrides.set(tenantPartitionKey(entry), quota);
  }

  const windows = new Map<string, IngestSample[]>();
  const tenantLocks = new Map<string, Promise<void>>();

  const takeTenantLock = async (key: string): Promise<() => void> => {
    const previous = tenantLocks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => current);
    tenantLocks.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (tenantLocks.get(key) === tail) tenantLocks.delete(key);
      unlock();
    };
  };

  const resolveQuota = (tenant: TenantScope): TenantQuota | undefined => {
    if (quotas === undefined) return undefined;
    const key = tenantPartitionKey(tenant);
    const override = overrides.get(key);
    if (override === undefined) return quotas.default;
    if (quotas.default === undefined) return override;
    return { ...quotas.default, ...override };
  };

  const pruneWindow = (key: string, currentMs: number): IngestSample[] => {
    const samples = windows.get(key) ?? [];
    const cutoff = currentMs - WINDOW_MS;
    while (samples.length > 0 && (samples[0]?.atMs ?? 0) <= cutoff) {
      samples.shift();
    }
    if (samples.length === 0) windows.delete(key);
    else windows.set(key, samples);
    return samples;
  };

  return {
    async acquire(tenant, request) {
      const key = tenantPartitionKey(tenant);
      const releaseLock = await takeTenantLock(key);

      try {
        const quota = resolveQuota(tenant);
        if (quota === undefined) return { allowed: true, release: releaseLock };

        const ingestItems = request.ingestItems ?? 0;
        const currentMs = now();

        if (quota.maxIngestItemsPerMinute !== undefined && ingestItems > 0) {
          const samples = pruneWindow(key, currentMs);
          let used = 0;
          for (const sample of samples) used += sample.count;
          if (used + ingestItems > quota.maxIngestItemsPerMinute) {
            const oldest = samples[0]?.atMs ?? currentMs;
            const retryAfterSeconds = Math.max(
              1,
              Math.ceil((oldest + WINDOW_MS - currentMs) / 1000),
            );
            releaseLock();
            return {
              allowed: false,
              status: 429,
              retryAfterSeconds,
              body: errorBody(
                "rate-limited",
                `tenant ingest rate limit of ${quota.maxIngestItemsPerMinute} items per minute exceeded`,
                {
                  limit: { name: "maxIngestItemsPerMinute", value: quota.maxIngestItemsPerMinute },
                  retryAfterSeconds,
                },
              ),
            };
          }
        }

        if (quota.maxStoredRecords !== undefined && request.newStoredRecords !== undefined) {
          const requestedRecords =
            typeof request.newStoredRecords === "function"
              ? await request.newStoredRecords()
              : request.newStoredRecords;
          if (requestedRecords > 0) {
            const storedCount = await countTenantRecords(stores, tenant);
            if (storedCount + requestedRecords > quota.maxStoredRecords) {
              releaseLock();
              return {
                allowed: false,
                status: 429,
                retryAfterSeconds: STORAGE_RETRY_AFTER_SECONDS,
                body: errorBody(
                  "quota-exceeded",
                  `tenant stored record limit of ${quota.maxStoredRecords} reached`,
                  {
                    limit: { name: "maxStoredRecords", value: quota.maxStoredRecords },
                    stored: storedCount,
                    requested: requestedRecords,
                  },
                ),
              };
            }
          }
        }

        if (quota.maxIngestItemsPerMinute !== undefined && ingestItems > 0) {
          const samples = pruneWindow(key, currentMs);
          samples.push({ atMs: currentMs, count: ingestItems });
          windows.set(key, samples);
        }

        return { allowed: true, release: releaseLock };
      } catch (error) {
        releaseLock();
        throw error;
      }
    },
  };
}
