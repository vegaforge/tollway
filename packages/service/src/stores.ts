import { type CommitmentStore, createMemoryCommitmentStore } from "@vegaforge/tollway-channels";
import { canonicalJson, type Policy, type SignedReceipt } from "@vegaforge/tollway-core";
import {
  createObservabilityHub,
  type ExportFormat,
  type MetricsQuery,
  type PaymentMetric,
  type SpendSummary,
  type TimeseriesQuery,
  type TimeseriesResult,
} from "@vegaforge/tollway-observability";

/**
 * Storage behind the service. Each kind of record sits behind an interface,
 * so the routes in #225 to #228 and the persistent backends in #217, #222,
 * #177 and #230 plug in without changing the skeleton. The in-memory
 * implementations here keep state for the life of the process only.
 *
 * Every store answers `check()` for `/readyz`: it resolves when the store can
 * serve requests and rejects when it cannot. A memory store is always ready.
 */
export interface ServiceStore {
  check(): Promise<void>;
}

/** What {@link ReceiptStore.put} did with a receipt. */
export type ReceiptPutResult =
  /** First time this receipt id was seen. */
  | "stored"
  /** The same receipt was stored before; nothing changed. */
  | "duplicate"
  /** A different receipt is already stored under this id; nothing changed. */
  | "conflict";

/** Signed receipts, stored exactly as received. */
export interface ReceiptStore extends ServiceStore {
  put(receipt: SignedReceipt): Promise<ReceiptPutResult>;
  get(id: string): Promise<SignedReceipt | undefined>;
}

/**
 * Payment metrics and their rollups. The rollup rules are the observability
 * hub's (`summarize`, `timeseries`, `export`), so a persistent backend (#217)
 * changes where metrics live, never how they are counted.
 */
export interface MetricsStore extends ServiceStore {
  record(metrics: readonly PaymentMetric[]): Promise<void>;
  summarize(query?: MetricsQuery): Promise<SpendSummary>;
  /**
   * Bucketed spend, counts and latency. Rejects with
   * `MetricsQueryTooLargeError` when the range needs more buckets or rows
   * than the store allows.
   */
  timeseries(query: TimeseriesQuery): Promise<TimeseriesResult>;
  /** The matched metrics as JSON or CSV, as `ObservabilityHub.export` writes them. */
  export(format: ExportFormat, query?: MetricsQuery): Promise<string>;
}

/** MPP channels and their commitment streams, as `@vegaforge/tollway-channels` defines them. */
export interface ChannelStore extends ServiceStore, CommitmentStore {}

/** One immutable version of an agent's policy. */
export type PolicyVersion = {
  agentId: string;
  /** Starts at 1 and increases by one per change. */
  version: number;
  policy: Policy;
  /** ISO 8601 time the version was stored. */
  createdAt: string;
};

/** Versioned policies per agent. A version, once stored, never changes. */
export interface PolicyStore extends ServiceStore {
  current(agentId: string): Promise<PolicyVersion | undefined>;
  versions(agentId: string): Promise<readonly PolicyVersion[]>;
  /**
   * Stores `policy` as the next version when the current version is
   * `expectedVersion` (`null` when the agent has none yet). Returns
   * `"version-conflict"` otherwise, so a concurrent edit is never overwritten.
   */
  append(
    agentId: string,
    policy: Policy,
    expectedVersion: number | null,
  ): Promise<PolicyVersion | "version-conflict">;
}

export type ServiceStores = {
  receipts: ReceiptStore;
  metrics: MetricsStore;
  channels: ChannelStore;
  policies: PolicyStore;
};

const ready = async (): Promise<void> => {};

export function createMemoryReceiptStore(): ReceiptStore {
  const receipts = new Map<string, { receipt: SignedReceipt; canonical: string }>();
  return {
    check: ready,
    async put(receipt) {
      const id = receipt.receipt.id;
      // Identity is the canonical form, the same bytes the signature covers,
      // so key order in the submitted JSON does not make a duplicate look new.
      const canonical = canonicalJson(receipt);
      const existing = receipts.get(id);
      if (existing !== undefined)
        return existing.canonical === canonical ? "duplicate" : "conflict";
      receipts.set(id, { receipt: structuredClone(receipt), canonical });
      return "stored";
    },
    async get(id) {
      const found = receipts.get(id);
      return found === undefined ? undefined : structuredClone(found.receipt);
    },
  };
}

export function createMemoryMetricsStore(): MetricsStore {
  // The observability hub already owns the rollup rules; the store only
  // adapts it to the asynchronous interface a database backend needs.
  const hub = createObservabilityHub();
  return {
    check: ready,
    async record(metrics) {
      for (const metric of metrics) hub.record(metric);
    },
    async summarize(query) {
      return hub.summarize(query);
    },
    async timeseries(query) {
      return hub.timeseries(query);
    },
    async export(format, query) {
      return hub.export(format, query);
    },
  };
}

export function createMemoryChannelStore(): ChannelStore {
  return { ...createMemoryCommitmentStore(), check: ready };
}

export function createMemoryPolicyStore(options?: { clock?: () => number }): PolicyStore {
  const clock = options?.clock ?? Date.now;
  const byAgent = new Map<string, PolicyVersion[]>();
  return {
    check: ready,
    async current(agentId) {
      return byAgent.get(agentId)?.at(-1);
    },
    async versions(agentId) {
      return [...(byAgent.get(agentId) ?? [])];
    },
    async append(agentId, policy, expectedVersion) {
      const history = byAgent.get(agentId) ?? [];
      const currentVersion = history.at(-1)?.version ?? null;
      if (currentVersion !== expectedVersion) return "version-conflict";
      const next: PolicyVersion = {
        agentId,
        version: (currentVersion ?? 0) + 1,
        policy: structuredClone(policy),
        createdAt: new Date(clock()).toISOString(),
      };
      history.push(next);
      byAgent.set(agentId, history);
      return next;
    },
  };
}

/** One memory store of each kind. */
export function createMemoryStores(): ServiceStores {
  return {
    receipts: createMemoryReceiptStore(),
    metrics: createMemoryMetricsStore(),
    channels: createMemoryChannelStore(),
    policies: createMemoryPolicyStore(),
  };
}
