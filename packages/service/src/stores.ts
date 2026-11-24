import {
  type Channel,
  type ChannelListFilter,
  type ChannelManager,
  type ChannelStatus,
  type ClosePolicy,
  type Commitment,
  type CommitmentAppendExpectation,
  type CommitmentStore,
  createChannelManager,
  createMemoryCommitmentStore,
  type MppChannelAdapter,
} from "@vegaforge/tollway-channels";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  type CounterpartyQuarantine,
  type Policy,
  type SignedReceipt,
  TollwayError,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import {
  type ArchiveSearchOptions,
  createMemoryReceiptArchive,
  createObservabilityHub,
  type ExportFormat,
  type MetricsQuery,
  type PaymentMetric,
  type ReceiptArchive,
  type ReceiptFilter,
  type SpendSummary,
  type TimeseriesQuery,
  type TimeseriesResult,
} from "@vegaforge/tollway-observability";
import { scopedRecordKey, type TenantScope, tenantPartitionKey } from "./tenancy.js";

/**
 * Multi-tenant storage behind the service (#231). Every store method takes a
 * {@link TenantScope} (`{ orgId, projectId }`), and every stored record
 * carries it. Isolation lives in the partition and primary key rather than a
 * post-query filter, so two projects can use identical receipt ids, channel
 * ids or agent ids without conflict.
 *
 * None of the five tenant stores exposes a cross-tenant read. The only
 * cross-tenant overview sits behind the separate {@link AdminStore}, which
 * returns per-tenant counts and never raw payment records.
 *
 * Every store answers `check()` for `/readyz`: it resolves when the store can
 * serve requests and rejects when it cannot.
 */
export interface ServiceStore {
  /** Resolves when the store is healthy and rejects when it cannot serve requests. */
  check(): Promise<void>;
}

/** What {@link ReceiptStore.put} did with a receipt. */
export type ReceiptPutResult =
  /** First time this receipt id was seen in this tenant. */
  | "stored"
  /** The same receipt was stored before in this tenant; nothing changed. */
  | "duplicate"
  /** A different receipt is already stored under this id in this tenant; nothing changed. */
  | "conflict";

/** A signed receipt together with the tenant that owns it. */
export type StoredReceipt = TenantScope & {
  receipt: SignedReceipt;
};

/** One page of tenant-scoped receipts returned by {@link ReceiptStore.list}. */
export type StoredReceiptPage = {
  items: StoredReceipt[];
  nextCursor: string | null;
};

/** Signed receipts, partitioned by `(orgId, projectId, receipt.id)`. */
export interface ReceiptStore extends ServiceStore {
  put(tenant: TenantScope, receipt: SignedReceipt): Promise<ReceiptPutResult>;
  get(tenant: TenantScope, id: string): Promise<StoredReceipt | undefined>;
  list(
    tenant: TenantScope,
    filter?: ReceiptFilter,
    page?: ArchiveSearchOptions,
  ): Promise<StoredReceiptPage>;
  count(tenant: TenantScope): Promise<number>;
}

/**
 * Payment metrics and their rollups, partitioned by `(orgId, projectId)`. The
 * rollup rules stay the observability hub's (`summarize`, `timeseries`,
 * `export`).
 */
export interface MetricsStore extends ServiceStore {
  record(tenant: TenantScope, metrics: readonly PaymentMetric[]): Promise<void>;
  summarize(tenant: TenantScope, query?: MetricsQuery): Promise<SpendSummary>;
  /**
   * Bucketed spend, counts and latency. Rejects with
   * `MetricsQueryTooLargeError` when the range needs more buckets or rows
   * than the store allows.
   */
  timeseries(tenant: TenantScope, query: TimeseriesQuery): Promise<TimeseriesResult>;
  /** The matched metrics as JSON or CSV, as `ObservabilityHub.export` writes them. */
  export(tenant: TenantScope, format: ExportFormat, query?: MetricsQuery): Promise<string>;
  count(tenant: TenantScope): Promise<number>;
}

/** A tracked channel together with the tenant that owns it. */
export type ScopedChannel = Channel & TenantScope;

/** A channel commitment together with the tenant that owns it. */
export type ScopedCommitment = Commitment & TenantScope;

/** One page of tenant-scoped channels returned by {@link ChannelStore.listChannels}. */
export type ScopedChannelPage = {
  channels: ScopedChannel[];
  nextCursor?: string;
};

/** MPP channels and their commitment streams, partitioned by `(orgId, projectId, channelId)`. */
export interface ChannelStore extends ServiceStore {
  putChannel(tenant: TenantScope, channel: Channel): Promise<void>;
  getChannel(tenant: TenantScope, channelId: string): Promise<ScopedChannel | undefined>;
  updateChannel(
    tenant: TenantScope,
    channelId: string,
    patch: Partial<Channel>,
  ): Promise<ScopedChannel | undefined>;
  appendCommitment(
    tenant: TenantScope,
    commitment: Commitment,
    expectation: CommitmentAppendExpectation,
  ): Promise<ScopedChannel>;
  transitionChannel(
    tenant: TenantScope,
    channelId: string,
    expectedStatus: ChannelStatus,
    patch: Partial<Channel>,
  ): Promise<ScopedChannel>;
  listCommitments(tenant: TenantScope, channelId: string): Promise<readonly ScopedCommitment[]>;
  listChannelsByStatus(
    tenant: TenantScope,
    status: Channel["status"],
  ): Promise<readonly ScopedChannel[]>;
  listChannels(tenant: TenantScope, filter?: ChannelListFilter): Promise<ScopedChannelPage>;
  count(tenant: TenantScope): Promise<number>;
}

/** One immutable version of an agent's policy inside a tenant. */
export type PolicyVersion = TenantScope & {
  agentId: string;
  /** Starts at 1 within `(orgId, projectId, agentId)` and increases by one per change. */
  version: number;
  /** `null` when the policy was retired with a tombstone version. */
  policy: Policy | null;
  /** ISO 8601 time the version was stored. */
  createdAt: string;
};

/** Versioned policies per `(orgId, projectId, agentId)`. A version, once stored, never changes. */
export interface PolicyStore extends ServiceStore {
  current(tenant: TenantScope, agentId: string): Promise<PolicyVersion | undefined>;
  versions(tenant: TenantScope, agentId: string): Promise<readonly PolicyVersion[]>;
  /** One stored version of the agent's policy in this tenant, or `undefined`. */
  getVersion(
    tenant: TenantScope,
    agentId: string,
    version: number,
  ): Promise<PolicyVersion | undefined>;
  /**
   * Stores `policy` as the next version when the current version in this
   * tenant is `expectedVersion` (`null` when the agent has none yet). Returns
   * `"version-conflict"` otherwise, so a concurrent edit is never overwritten.
   */
  append(
    tenant: TenantScope,
    agentId: string,
    policy: Policy | null,
    expectedVersion: number | null,
  ): Promise<PolicyVersion | "version-conflict">;
  count(tenant: TenantScope): Promise<number>;
}

/** One field change recorded in a policy or administrative audit entry. */
export type AuditDiffEntry = {
  path: string;
  before?: unknown;
  after?: unknown;
};

/** An immutable, tenant-scoped audit record. */
export type AuditEntry = TenantScope & {
  id: string;
  action: string;
  /** Name of the API key that triggered the change, never the key itself. */
  actorKey: string;
  agentId?: string;
  resourceId?: string;
  version?: number;
  changes?: readonly AuditDiffEntry[];
  createdAt: string;
};

/** Fields passed to {@link AuditStore.append}. */
export type AuditEntryInput = {
  id?: string;
  action: string;
  actorKey: string;
  agentId?: string;
  resourceId?: string;
  version?: number;
  changes?: readonly AuditDiffEntry[];
  createdAt?: string;
};

/** Filter parameters accepted by {@link AuditStore.list}. */
export type AuditListFilter = {
  agentId?: string;
  action?: string;
};

/** Cursor pagination parameters accepted by {@link AuditStore.list}. */
export type AuditPageOptions = {
  limit?: number;
  cursor?: string;
};

/** One page of tenant-scoped audit entries returned by {@link AuditStore.list}. */
export type AuditPage = {
  entries: AuditEntry[];
  nextCursor?: string;
};

/** Append-only audit log partitioned by `(orgId, projectId)`. */
export interface AuditStore extends ServiceStore {
  append(tenant: TenantScope, entry: AuditEntryInput): Promise<AuditEntry>;
  list(tenant: TenantScope, filter?: AuditListFilter, page?: AuditPageOptions): Promise<AuditPage>;
  count(tenant: TenantScope): Promise<number>;
}

/** Per-tenant record counts returned to operator keys through {@link AdminStore}. */
export type TenantSummary = TenantScope & {
  receipts: number;
  metrics: number;
  channels: number;
  commitments: number;
  policyVersions: number;
  auditEntries: number;
  totalRecords: number;
};

/**
 * Explicit cross-tenant operator store. Kept off {@link ServiceStores} so
 * tenant routes cannot call it by mistake.
 */
export interface AdminStore extends ServiceStore {
  listTenants(): Promise<readonly TenantSummary[]>;
}

/** The five tenant-scoped backing stores used by `/v1/*` tenant routes. */
export type ServiceStores = {
  receipts: ReceiptStore;
  metrics: MetricsStore;
  channels: ChannelStore;
  policies: PolicyStore;
  audit: AuditStore;
};

/**
 * Adapts a multi-tenant {@link ChannelStore} to `@vegaforge/tollway-channels`'s
 * `CommitmentStore` for one specific tenant.
 */
export function bindTenantChannelStore(store: ChannelStore, tenant: TenantScope): CommitmentStore {
  const stripChannel = ({ orgId: _o, projectId: _p, ...rest }: ScopedChannel): Channel => rest;
  const stripCommitment = ({ orgId: _o, projectId: _p, ...rest }: ScopedCommitment): Commitment =>
    rest;

  return {
    async putChannel(channel) {
      await store.putChannel(tenant, channel);
    },
    async getChannel(channelId) {
      const found = await store.getChannel(tenant, channelId);
      return found === undefined ? undefined : stripChannel(found);
    },
    async updateChannel(channelId, patch) {
      const updated = await store.updateChannel(tenant, channelId, patch);
      return updated === undefined ? undefined : stripChannel(updated);
    },
    async appendCommitment(commitment, expectation) {
      return stripChannel(await store.appendCommitment(tenant, commitment, expectation));
    },
    async transitionChannel(channelId, expectedStatus, patch) {
      return stripChannel(await store.transitionChannel(tenant, channelId, expectedStatus, patch));
    },
    async listCommitments(channelId) {
      return (await store.listCommitments(tenant, channelId)).map(stripCommitment);
    },
    async listChannelsByStatus(status) {
      return (await store.listChannelsByStatus(tenant, status)).map(stripChannel);
    },
    async listChannels(filter) {
      const page = await store.listChannels(tenant, filter);
      return page.nextCursor === undefined
        ? { channels: page.channels.map(stripChannel) }
        : { channels: page.channels.map(stripChannel), nextCursor: page.nextCursor };
    },
  };
}

/** Options passed to {@link createTenantChannelManagers}. */
export type TenantChannelManagersOptions = {
  store: ChannelStore;
  adapter: MppChannelAdapter | ((tenant: TenantScope) => MppChannelAdapter);
  closePolicy?: ClosePolicy;
  quarantine?: CounterpartyQuarantine;
  now?: () => string;
};

/**
 * Builds a lazy per-tenant `ChannelManager` resolver backed by one shared
 * {@link ChannelStore}, isolating each `(orgId, projectId)` partition.
 */
export function createTenantChannelManagers(
  options: TenantChannelManagersOptions,
): (tenant: TenantScope) => ChannelManager {
  const byTenant = new Map<string, ChannelManager>();
  return (tenant) => {
    const key = tenantPartitionKey(tenant);
    const existing = byTenant.get(key);
    if (existing !== undefined) return existing;
    const adapter =
      typeof options.adapter === "function" ? options.adapter(tenant) : options.adapter;
    const manager = createChannelManager({
      adapter,
      store: bindTenantChannelStore(options.store, tenant),
      ...(options.closePolicy === undefined ? {} : { closePolicy: options.closePolicy }),
      ...(options.quarantine === undefined ? {} : { quarantine: options.quarantine }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    byTenant.set(key, manager);
    return manager;
  };
}

const ready = async (): Promise<void> => {};

type TenantRegistry = {
  touch(tenant: TenantScope): void;
  tenants(): readonly TenantScope[];
};

const storeRegistries = new WeakMap<ServiceStore, TenantRegistry>();
const channelBreakdown = new WeakMap<
  ChannelStore,
  (tenant: TenantScope) => { channels: number; commitments: number }
>();

function createTenantRegistry(): TenantRegistry {
  const known = new Map<string, TenantScope>();
  return {
    touch(tenant) {
      const key = tenantPartitionKey(tenant);
      if (!known.has(key)) known.set(key, { orgId: tenant.orgId, projectId: tenant.projectId });
    },
    tenants() {
      return [...known.values()];
    },
  };
}

/** Creates an in-memory, tenant-partitioned {@link ReceiptStore}. */
export function createMemoryReceiptStore(): ReceiptStore {
  const registry = createTenantRegistry();
  const partitions = new Map<string, { archive: ReceiptArchive; count: number }>();

  const getPartition = (tenant: TenantScope) => {
    const key = tenantPartitionKey(tenant);
    let partition = partitions.get(key);
    if (partition === undefined) {
      partition = { archive: createMemoryReceiptArchive(), count: 0 };
      partitions.set(key, partition);
    }
    return partition;
  };

  const store: ReceiptStore = {
    check: ready,
    async put(tenant, receipt) {
      registry.touch(tenant);
      const partition = getPartition(tenant);
      try {
        const outcome = await partition.archive.append(receipt);
        if (outcome === "appended") {
          partition.count += 1;
          return "stored";
        }
        return "duplicate";
      } catch (error) {
        if (error instanceof TollwayError && error.code === "receipt-conflict") {
          return "conflict";
        }
        throw error;
      }
    },
    async get(tenant, id) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return undefined;
      const found = await partition.archive.get(id);
      return found === undefined
        ? undefined
        : { orgId: tenant.orgId, projectId: tenant.projectId, receipt: found };
    },
    async list(tenant, filter, page) {
      const partition = getPartition(tenant);
      const result = await partition.archive.search(filter, page);
      return {
        items: result.items.map((receipt) => ({
          orgId: tenant.orgId,
          projectId: tenant.projectId,
          receipt,
        })),
        nextCursor: result.nextCursor,
      };
    },
    async count(tenant) {
      return partitions.get(tenantPartitionKey(tenant))?.count ?? 0;
    },
  };
  storeRegistries.set(store, registry);
  return store;
}

/** Creates an in-memory, tenant-partitioned {@link MetricsStore}. */
export function createMemoryMetricsStore(): MetricsStore {
  const registry = createTenantRegistry();
  const partitions = new Map<
    string,
    { hub: ReturnType<typeof createObservabilityHub>; count: number }
  >();

  const getPartition = (tenant: TenantScope) => {
    const key = tenantPartitionKey(tenant);
    let partition = partitions.get(key);
    if (partition === undefined) {
      partition = { hub: createObservabilityHub(), count: 0 };
      partitions.set(key, partition);
    }
    return partition;
  };

  const store: MetricsStore = {
    check: ready,
    async record(tenant, metrics) {
      if (metrics.length > 0) registry.touch(tenant);
      const partition = getPartition(tenant);
      for (const metric of metrics) {
        partition.hub.record(metric);
        partition.count += 1;
      }
    },
    async summarize(tenant, query) {
      return getPartition(tenant).hub.summarize(query);
    },
    async timeseries(tenant, query) {
      return getPartition(tenant).hub.timeseries(query);
    },
    async export(tenant, format, query) {
      return getPartition(tenant).hub.export(format, query);
    },
    async count(tenant) {
      return partitions.get(tenantPartitionKey(tenant))?.count ?? 0;
    },
  };
  storeRegistries.set(store, registry);
  return store;
}

type ChannelPartition = {
  store: CommitmentStore;
  channelIds: Set<string>;
  commitmentCount: number;
};

/** Creates an in-memory, tenant-partitioned {@link ChannelStore}. */
export function createMemoryChannelStore(): ChannelStore {
  const registry = createTenantRegistry();
  const partitions = new Map<string, ChannelPartition>();

  const getPartition = (tenant: TenantScope): ChannelPartition => {
    const key = tenantPartitionKey(tenant);
    let partition = partitions.get(key);
    if (partition === undefined) {
      partition = {
        store: createMemoryCommitmentStore(),
        channelIds: new Set<string>(),
        commitmentCount: 0,
      };
      partitions.set(key, partition);
    }
    return partition;
  };

  const withTenantChannel = (tenant: TenantScope, channel: Channel): ScopedChannel => ({
    ...structuredClone(channel),
    orgId: tenant.orgId,
    projectId: tenant.projectId,
  });

  const withTenantCommitment = (tenant: TenantScope, commitment: Commitment): ScopedCommitment => ({
    ...structuredClone(commitment),
    orgId: tenant.orgId,
    projectId: tenant.projectId,
  });

  const store: ChannelStore = {
    check: ready,
    async putChannel(tenant, channel) {
      registry.touch(tenant);
      const partition = getPartition(tenant);
      await partition.store.putChannel(structuredClone(channel));
      partition.channelIds.add(channel.id);
    },
    async getChannel(tenant, channelId) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return undefined;
      const channel = await partition.store.getChannel(channelId);
      return channel === undefined ? undefined : withTenantChannel(tenant, channel);
    },
    async updateChannel(tenant, channelId, patch) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return undefined;
      const updated = await partition.store.updateChannel(channelId, structuredClone(patch));
      return updated === undefined ? undefined : withTenantChannel(tenant, updated);
    },
    async appendCommitment(tenant, commitment, expectation) {
      registry.touch(tenant);
      const partition = getPartition(tenant);
      const updated = await partition.store.appendCommitment(
        structuredClone(commitment),
        expectation,
      );
      partition.commitmentCount += 1;
      return withTenantChannel(tenant, updated);
    },
    async transitionChannel(tenant, channelId, expectedStatus, patch) {
      const partition = getPartition(tenant);
      const updated = await partition.store.transitionChannel(
        channelId,
        expectedStatus,
        structuredClone(patch),
      );
      return withTenantChannel(tenant, updated);
    },
    async listCommitments(tenant, channelId) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return [];
      const list = await partition.store.listCommitments(channelId);
      return list.map((commitment) => withTenantCommitment(tenant, commitment));
    },
    async listChannelsByStatus(tenant, status) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return [];
      const list = await partition.store.listChannelsByStatus(status);
      return list.map((channel) => withTenantChannel(tenant, channel));
    },
    async listChannels(tenant, filter) {
      const partition = getPartition(tenant);
      const page = await partition.store.listChannels(filter);
      const channels = page.channels.map((channel) => withTenantChannel(tenant, channel));
      return page.nextCursor === undefined
        ? { channels }
        : { channels, nextCursor: page.nextCursor };
    },
    async count(tenant) {
      const partition = partitions.get(tenantPartitionKey(tenant));
      if (partition === undefined) return 0;
      return partition.channelIds.size + partition.commitmentCount;
    },
  };
  storeRegistries.set(store, registry);
  channelBreakdown.set(store, (tenant) => {
    const partition = partitions.get(tenantPartitionKey(tenant));
    return {
      channels: partition?.channelIds.size ?? 0,
      commitments: partition?.commitmentCount ?? 0,
    };
  });
  return store;
}

/** Creates an in-memory, tenant-partitioned {@link PolicyStore}. */
export function createMemoryPolicyStore(options?: { clock?: () => number }): PolicyStore {
  const registry = createTenantRegistry();
  const clock = options?.clock ?? Date.now;
  const byScopedAgent = new Map<string, PolicyVersion[]>();
  const countsByTenant = new Map<string, number>();

  const store: PolicyStore = {
    check: ready,
    async current(tenant, agentId) {
      const latest = byScopedAgent.get(scopedRecordKey(tenant, agentId))?.at(-1);
      return latest === undefined ? undefined : structuredClone(latest);
    },
    async versions(tenant, agentId) {
      const history = byScopedAgent.get(scopedRecordKey(tenant, agentId)) ?? [];
      return history.map((entry) => structuredClone(entry));
    },
    async getVersion(tenant, agentId, version) {
      const history = byScopedAgent.get(scopedRecordKey(tenant, agentId)) ?? [];
      // Versions start at 1 and never skip, so version n sits at index n - 1.
      const found = history[version - 1];
      return found === undefined ? undefined : structuredClone(found);
    },
    async append(tenant, agentId, policy, expectedVersion) {
      const key = scopedRecordKey(tenant, agentId);
      const history = byScopedAgent.get(key) ?? [];
      const currentVersion = history.at(-1)?.version ?? null;
      if (currentVersion !== expectedVersion) return "version-conflict";
      registry.touch(tenant);
      const next: PolicyVersion = {
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        agentId,
        version: (currentVersion ?? 0) + 1,
        policy: policy === null ? null : structuredClone(policy),
        createdAt: new Date(clock()).toISOString(),
      };
      history.push(next);
      byScopedAgent.set(key, history);
      const partKey = tenantPartitionKey(tenant);
      countsByTenant.set(partKey, (countsByTenant.get(partKey) ?? 0) + 1);
      return structuredClone(next);
    },
    async count(tenant) {
      return countsByTenant.get(tenantPartitionKey(tenant)) ?? 0;
    },
  };
  storeRegistries.set(store, registry);
  return store;
}

const DEFAULT_AUDIT_PAGE_LIMIT = 50;
const MAX_AUDIT_PAGE_LIMIT = 200;

type StoredAuditRow = {
  seq: number;
  entry: AuditEntry;
};

function encodeAuditPosition(seq: number): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify({ seq })));
}

function decodeAuditPosition(cursor: string): number {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(cursor));
  } catch {
    throw new RangeError("cursor is not an audit cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new RangeError("cursor is not an audit cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1
  ) {
    throw new RangeError("cursor is not an audit cursor");
  }
  const seq = (parsed as { seq?: unknown }).seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError("cursor is not an audit cursor");
  }
  if (encodeAuditPosition(seq) !== cursor) {
    throw new RangeError("cursor is not canonical");
  }
  return seq;
}

/** Creates an in-memory, tenant-partitioned {@link AuditStore}. */
export function createMemoryAuditStore(options?: { clock?: () => number }): AuditStore {
  const registry = createTenantRegistry();
  const clock = options?.clock ?? Date.now;
  const partitions = new Map<string, StoredAuditRow[]>();

  const store: AuditStore = {
    check: ready,
    async append(tenant, input) {
      registry.touch(tenant);
      const key = tenantPartitionKey(tenant);
      const rows = partitions.get(key) ?? [];
      const seq = rows.length + 1;
      const entry: AuditEntry = {
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        id: input.id ?? `aud_${seq}`,
        action: input.action,
        actorKey: input.actorKey,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.changes === undefined ? {} : { changes: structuredClone(input.changes) }),
        createdAt: input.createdAt ?? new Date(clock()).toISOString(),
      };
      rows.push({ seq, entry });
      partitions.set(key, rows);
      return structuredClone(entry);
    },
    async list(tenant, filter = {}, page = {}) {
      const limit = page.limit ?? DEFAULT_AUDIT_PAGE_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE_LIMIT) {
        throw new RangeError(
          `limit must be an integer from 1 to ${MAX_AUDIT_PAGE_LIMIT}, got ${String(limit)}`,
        );
      }
      const beforeSeq =
        page.cursor === undefined ? Number.POSITIVE_INFINITY : decodeAuditPosition(page.cursor);
      const rows = partitions.get(tenantPartitionKey(tenant)) ?? [];
      const matched: StoredAuditRow[] = [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row === undefined || row.seq >= beforeSeq) continue;
        if (filter.agentId !== undefined && row.entry.agentId !== filter.agentId) continue;
        if (filter.action !== undefined && row.entry.action !== filter.action) continue;
        matched.push(row);
        if (matched.length > limit) break;
      }
      const slice = matched.slice(0, limit);
      const last = slice.at(-1);
      const entries = slice.map((row) => structuredClone(row.entry));
      return last !== undefined && matched.length > slice.length
        ? { entries, nextCursor: encodeAuditPosition(last.seq) }
        : { entries };
    },
    async count(tenant) {
      return partitions.get(tenantPartitionKey(tenant))?.length ?? 0;
    },
  };
  storeRegistries.set(store, registry);
  return store;
}

/**
 * Builds an in-memory {@link AdminStore} aggregating per-tenant counts across
 * any combination of memory-backed {@link ServiceStores}.
 */
export function createMemoryAdminStore(stores: ServiceStores): AdminStore {
  return {
    check: ready,
    async listTenants() {
      const merged = new Map<string, TenantScope>();
      for (const store of Object.values(stores)) {
        for (const tenant of storeRegistries.get(store)?.tenants() ?? []) {
          merged.set(tenantPartitionKey(tenant), tenant);
        }
      }
      const ordered = [...merged.values()].sort((left, right) => {
        if (left.orgId !== right.orgId) return left.orgId < right.orgId ? -1 : 1;
        if (left.projectId === right.projectId) return 0;
        return left.projectId < right.projectId ? -1 : 1;
      });

      const breakdown = channelBreakdown.get(stores.channels);
      const summaries: TenantSummary[] = [];
      for (const tenant of ordered) {
        const [receiptCount, metricCount, totalChannelRecords, policyCount, auditCount] =
          await Promise.all([
            stores.receipts.count(tenant),
            stores.metrics.count(tenant),
            stores.channels.count(tenant),
            stores.policies.count(tenant),
            stores.audit.count(tenant),
          ]);
        const channelCounts = breakdown
          ? breakdown(tenant)
          : { channels: totalChannelRecords, commitments: 0 };
        const totalRecords =
          receiptCount +
          metricCount +
          channelCounts.channels +
          channelCounts.commitments +
          policyCount +
          auditCount;
        summaries.push({
          orgId: tenant.orgId,
          projectId: tenant.projectId,
          receipts: receiptCount,
          metrics: metricCount,
          channels: channelCounts.channels,
          commitments: channelCounts.commitments,
          policyVersions: policyCount,
          auditEntries: auditCount,
          totalRecords,
        });
      }
      return summaries;
    },
  };
}

/** One memory store of each tenant-scoped kind. */
export function createMemoryStores(): ServiceStores {
  return {
    receipts: createMemoryReceiptStore(),
    metrics: createMemoryMetricsStore(),
    channels: createMemoryChannelStore(),
    policies: createMemoryPolicyStore(),
    audit: createMemoryAuditStore(),
  };
}

/** One memory store of each tenant-scoped kind, plus its matching {@link AdminStore}. */
export function createMemoryStoresWithAdmin(): { stores: ServiceStores; adminStore: AdminStore } {
  const stores = createMemoryStores();
  return { stores, adminStore: createMemoryAdminStore(stores) };
}
