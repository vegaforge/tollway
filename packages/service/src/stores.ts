import { type CommitmentStore, createMemoryCommitmentStore } from "@vegaforge/tollway-channels";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  type JsonValue,
  type Policy,
  type SignedReceipt,
  utf8Bytes,
} from "@vegaforge/tollway-core";
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

/** One immutable version of an agent's policy. `policy` is `null` for a retired tombstone version. */
export type PolicyVersion = {
  agentId: string;
  /** Starts at 1 and increases by one per change. */
  version: number;
  policy: Policy | null;
  /** ISO 8601 time the version was stored. */
  createdAt: string;
};

/** One structural change between two policy versions. */
export type PolicyDiffOp = "add" | "remove" | "replace";

/** A deterministic JSON-path diff entry between two policy documents. */
export type PolicyDiffEntry = {
  /** Dot-separated JSON path (e.g. `budgets.daily`), or `(root)` for whole-document create/retire. */
  path: string;
  op: PolicyDiffOp;
  before?: unknown;
  after?: unknown;
};

/** Kind of policy change recorded in the audit log. */
export type PolicyAuditAction = "create" | "update" | "retire";

/** One immutable audit record written for each policy version. */
export type PolicyAuditEntry = {
  /** Monotonic 1-based sequence across all audit records in the store. */
  sequence: number;
  agentId: string;
  version: number;
  action: PolicyAuditAction;
  /** Name of the API key that performed the change (never the key itself). */
  actor: string;
  /** ISO 8601 timestamp when the change was recorded. */
  createdAt: string;
  diff: readonly PolicyDiffEntry[];
};

/** Filter and pagination options for {@link PolicyStore.listAudit}. */
export type PolicyAuditQuery = {
  agentId?: string;
  cursor?: string;
  limit?: number;
};

/** One page of {@link PolicyAuditEntry} records. */
export type PolicyAuditPage = {
  entries: readonly PolicyAuditEntry[];
  nextCursor?: string;
};

/** Thrown when an audit cursor cannot be decoded. */
export class InvalidAuditCursorError extends Error {
  constructor(cursor: string) {
    super(`invalid audit cursor: ${cursor}`);
    this.name = "InvalidAuditCursorError";
  }
}

/** Versioned policies per agent. A version, once stored, never changes. */
export interface PolicyStore extends ServiceStore {
  current(agentId: string): Promise<PolicyVersion | undefined>;
  versions(agentId: string): Promise<readonly PolicyVersion[]>;
  getVersion(agentId: string, version: number): Promise<PolicyVersion | undefined>;
  /**
   * Stores `policy` (or `null` for a retired tombstone) as the next version
   * when the current version is `expectedVersion` (`null` when the agent has
   * none yet). Returns `"version-conflict"` otherwise, so a concurrent edit
   * is never overwritten.
   */
  append(
    agentId: string,
    policy: Policy | null,
    expectedVersion: number | null,
    actor?: string,
  ): Promise<PolicyVersion | "version-conflict">;
  listAudit(query?: PolicyAuditQuery): Promise<PolicyAuditPage>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: PolicyDiffEntry[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const prev = before[key];
    const next = after[key];
    if (prev === undefined && next === undefined) continue;
    if (prev === undefined) {
      out.push({ path, op: "add", after: structuredClone(next) });
      continue;
    }
    if (next === undefined) {
      out.push({ path, op: "remove", before: structuredClone(prev) });
      continue;
    }
    if (isPlainObject(prev) && isPlainObject(next)) {
      collectDiff(prev, next, path, out);
      continue;
    }
    if (canonicalJson(prev as JsonValue) !== canonicalJson(next as JsonValue)) {
      out.push({
        path,
        op: "replace",
        before: structuredClone(prev),
        after: structuredClone(next),
      });
    }
  }
}

/**
 * Computes a deterministic, sorted-key JSON-path diff between two policy
 * documents (or `null` when creating or retiring).
 */
export function diffPolicies(before: Policy | null, after: Policy | null): PolicyDiffEntry[] {
  if (before === null && after === null) return [];
  if (before === null) return [{ path: "(root)", op: "add", after: structuredClone(after) }];
  if (after === null) return [{ path: "(root)", op: "remove", before: structuredClone(before) }];
  const out: PolicyDiffEntry[] = [];
  collectDiff(before as Record<string, unknown>, after as Record<string, unknown>, "", out);
  return out;
}

const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 200;

function encodeAuditCursor(sequence: number): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify(sequence)));
}

function decodeAuditCursor(cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(cursor)));
  } catch {
    throw new InvalidAuditCursorError(cursor);
  }
  if (typeof decoded !== "number" || !Number.isSafeInteger(decoded) || decoded < 1) {
    throw new InvalidAuditCursorError(cursor);
  }
  return decoded;
}

export function createMemoryPolicyStore(options?: { clock?: () => number }): PolicyStore {
  const clock = options?.clock ?? Date.now;
  const byAgent = new Map<string, PolicyVersion[]>();
  const audit: PolicyAuditEntry[] = [];
  return {
    check: ready,
    async current(agentId) {
      const latest = byAgent.get(agentId)?.at(-1);
      return latest === undefined ? undefined : structuredClone(latest);
    },
    async versions(agentId) {
      return structuredClone(byAgent.get(agentId) ?? []);
    },
    async getVersion(agentId, version) {
      const found = (byAgent.get(agentId) ?? []).find((entry) => entry.version === version);
      return found === undefined ? undefined : structuredClone(found);
    },
    async append(agentId, policy, expectedVersion, actor = "system") {
      const history = byAgent.get(agentId) ?? [];
      const prev = history.at(-1);
      const currentVersion = prev?.version ?? null;
      if (currentVersion !== expectedVersion) return "version-conflict";
      const createdAt = new Date(clock()).toISOString();
      const next: PolicyVersion = {
        agentId,
        version: (currentVersion ?? 0) + 1,
        policy: structuredClone(policy),
        createdAt,
      };
      history.push(next);
      byAgent.set(agentId, history);

      const action: PolicyAuditAction =
        policy === null
          ? "retire"
          : prev === undefined || prev.policy === null
            ? "create"
            : "update";
      audit.push({
        sequence: audit.length + 1,
        agentId,
        version: next.version,
        action,
        actor,
        createdAt,
        diff: diffPolicies(prev?.policy ?? null, policy),
      });
      return structuredClone(next);
    },
    async listAudit(query) {
      const limit = Math.min(Math.max(query?.limit ?? DEFAULT_AUDIT_PAGE, 1), MAX_AUDIT_PAGE);
      const cursorSequence =
        query?.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
      const filtered = [...audit].reverse().filter((entry) => {
        if (query?.agentId !== undefined && entry.agentId !== query.agentId) return false;
        if (cursorSequence !== undefined && entry.sequence >= cursorSequence) return false;
        return true;
      });
      const pageEntries = filtered.slice(0, limit).map((entry) => structuredClone(entry));
      const last = pageEntries.at(-1);
      const nextCursor =
        filtered.length > limit && last !== undefined
          ? encodeAuditCursor(last.sequence)
          : undefined;
      return nextCursor === undefined
        ? { entries: pageEntries }
        : { entries: pageEntries, nextCursor };
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
