/**
 * Data layer for the agent detail page (`/agents/[agentId]`).
 *
 * The page needs four things the service does not serve yet: which payer
 * addresses belong to an agent, that agent's settled spend over time (#226),
 * the policy that governs it (#228), and the decision traces of its recent
 * policy stops. Until those land, `fetchAgentDetail` reads a deterministic
 * stub through the same functions the real data will use:
 *
 * - spend comes from an `@vegaforge/tollway-observability` hub's `timeseries`
 *   query, filtered by payer, so the series and every total count settled
 *   payments only and never add amounts in different assets;
 * - policy stops are `PolicyTrace`s from `@vegaforge/tollway-core`'s
 *   `evaluate`, parsed with `policyTraceSchema` as a stored trace would be.
 *
 * Swapping the stub for the service changes the hub and the stop source,
 * not the shape below. See docs/dashboard-data-contracts.md, "Agent detail".
 */

import {
  createPolicyEngine,
  type PaymentIntent,
  type Policy,
  type PolicyRuleId,
  type PolicyRuleName,
  type PolicyTrace,
  policyTraceSchema,
  type SettlementModel,
} from "@vegaforge/tollway-core";
import {
  createObservabilityHub,
  type ObservabilityHub,
  type PaymentMetric,
  type TimeseriesBucket,
  type TimeseriesGroupBy,
} from "@vegaforge/tollway-observability";

export type Bucket = "hour" | "day";
export type Range = "24h" | "7d" | "30d";

export const buckets: readonly Bucket[] = ["hour", "day"];
export const ranges: readonly Range[] = ["24h", "7d", "30d"];

export type AgentDetailQuery = { bucket: Bucket; range: Range };

/** An amount in one asset's base units. Different assets are never summed. */
export type AssetAmount = { asset: string; amount: string };

export type SeriesPoint = {
  /** Bucket start, inclusive, ISO 8601 UTC. */
  start: string;
  /** Bucket end, exclusive, ISO 8601 UTC. */
  end: string;
  /** Settled spend in the bucket, base units. "0" for an empty bucket. */
  amount: string;
};

export type AssetSeries = { asset: string; points: SeriesPoint[] };

export type AmountByKey = { key: string; asset: string; amount: string };

/** One ceiling from the policy and what has been spent against it, per asset. */
export type LimitUsage = {
  /** The policy's limit as written, base units, or null when the policy sets none. */
  limit: string | null;
  /** Settled spend in the limit's window, one entry per asset seen. */
  usedByAsset: AssetAmount[];
  /** Window start, inclusive, ISO 8601 UTC. */
  windowStart: string;
};

export type ServiceCapUsage = LimitUsage & { payee: string };

export type AgentPolicyUsage = {
  document: Policy;
  /** When this policy started governing the agent; start of the lifetime windows. */
  effectiveFrom: string;
  /** The UTC day the daily window covers, `YYYY-MM-DD`, as the engine's `utcDate`. */
  utcDay: string;
  daily: LimitUsage;
  total: LimitUsage;
  perService: ServiceCapUsage[];
};

export type PolicyStop = {
  at: string;
  /** The rule that blocked, as the trace's `blockedBy`. */
  ruleId: PolicyRuleId;
  /** The coarser rule name `check()` reports. */
  rule: PolicyRuleName;
  detail: string;
  trace: PolicyTrace;
};

export type AgentDetail = {
  id: string;
  label: string;
  /**
   * The payer addresses this agent pays from. `PaymentMetric.payer` is an
   * address, not an agent id, so this list is the agent-to-payer mapping.
   */
  payerAddresses: string[];
  query: AgentDetailQuery;
  /** Range start, inclusive, and end, exclusive, ISO 8601 UTC. */
  from: string;
  to: string;
  series: AssetSeries[];
  /** Settled spend in the range, per model and asset. */
  byModel: AmountByKey[];
  /** Settled spend in the range, per payee and asset. */
  byPayee: AmountByKey[];
  /** Null when no policy governs this agent. */
  policy: AgentPolicyUsage | null;
  /** Newest first. */
  recentStops: PolicyStop[];
};

export class UnknownAgentError extends Error {
  constructor(agentId: string) {
    super(`No agent with id ${agentId}`);
    this.name = "UnknownAgentError";
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const BUCKET_WIDTH: Record<Bucket, { query: TimeseriesBucket; ms: number }> = {
  hour: { query: "1h", ms: HOUR_MS },
  day: { query: "1d", ms: DAY_MS },
};

const RANGE_MS: Record<Range, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

const BASIS_POINTS = 10_000n;

/**
 * `used / limit` in basis points (1% = 100), multiplying before dividing so
 * no precision is lost to integer division, and never through a float.
 * A zero limit has no meaningful percentage, so it returns null and the
 * caller says "limit is 0" instead.
 */
export function percentageBasisPoints(used: bigint, limit: bigint): bigint | null {
  if (limit <= 0n) return null;
  return (used * BASIS_POINTS) / limit;
}

/** `[from, to)` for a range ending at the end of the bucket that holds `now`. */
export function rangeWindow(now: number, query: AgentDetailQuery): { from: string; to: string } {
  const width = BUCKET_WIDTH[query.bucket].ms;
  // Bucket edges are multiples of the width from the epoch, which is how the
  // hub cuts them, so hour and day buckets fall on UTC boundaries.
  const to = Math.floor(now / width) * width + width;
  const from = to - RANGE_MS[query.range];
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The UTC day `now` falls in, the same string the policy engine's `utcDate` produces. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function addTo(map: Map<string, bigint>, key: string, amount: string): void {
  map.set(key, (map.get(key) ?? 0n) + BigInt(amount));
}

type SettledRow = { start: string; end: string; asset: string; key: string; amount: string };

/**
 * Settled spend for every payer address of one agent, one row per bucket,
 * asset, and `groupBy` key. The hub filters one payer per query, so each
 * address is queried and the rows are merged.
 */
function settledRows(
  hub: ObservabilityHub,
  payers: readonly string[],
  window: { from: string; to: string },
  bucket: TimeseriesBucket,
  groupBy: TimeseriesGroupBy,
): SettledRow[] {
  const rows: SettledRow[] = [];
  for (const payer of payers) {
    const result = hub.timeseries({ payer, from: window.from, to: window.to, bucket, groupBy });
    for (const entry of result.buckets) {
      for (const row of entry.rows) {
        const key = groupBy === "payee" ? (row.payee ?? "") : row.model;
        rows.push({
          start: entry.start,
          end: entry.end,
          asset: row.asset,
          key,
          amount: row.amount,
        });
      }
    }
  }
  return rows;
}

/** Per asset, every bucket in the window in time order, empty ones as "0". */
export function seriesByAsset(rows: readonly SettledRow[]): AssetSeries[] {
  const bucketEnds = new Map<string, string>();
  const byAsset = new Map<string, Map<string, bigint>>();
  for (const row of rows) {
    bucketEnds.set(row.start, row.end);
    const totals = byAsset.get(row.asset) ?? new Map<string, bigint>();
    addTo(totals, row.start, row.amount);
    byAsset.set(row.asset, totals);
  }
  const starts = [...bucketEnds.keys()].sort();
  return [...byAsset.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset, totals]) => ({
      asset,
      points: starts.map((start) => ({
        start,
        end: bucketEnds.get(start) ?? start,
        amount: (totals.get(start) ?? 0n).toString(),
      })),
    }));
}

/** Range totals per key and asset, largest first, zero rows dropped. */
export function totalsByKey(rows: readonly SettledRow[]): AmountByKey[] {
  const totals = new Map<string, { key: string; asset: string; amount: bigint }>();
  for (const row of rows) {
    // A JSON pair cannot collide the way "key:asset" would for a key with a colon.
    const id = JSON.stringify([row.key, row.asset]);
    const current = totals.get(id) ?? { key: row.key, asset: row.asset, amount: 0n };
    current.amount += BigInt(row.amount);
    totals.set(id, current);
  }
  return [...totals.values()]
    .filter((entry) => entry.amount > 0n)
    .sort((left, right) =>
      left.amount === right.amount
        ? left.key.localeCompare(right.key)
        : left.amount > right.amount
          ? -1
          : 1,
    )
    .map((entry) => ({ key: entry.key, asset: entry.asset, amount: entry.amount.toString() }));
}

function usedByAsset(
  rows: readonly SettledRow[],
  keep: (row: SettledRow) => boolean,
): AssetAmount[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (keep(row)) addTo(totals, row.asset, row.amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}

/**
 * Spend against each ceiling, over the window the policy engine uses for it
 * (packages/core/src/policy.ts): the daily budget over the current UTC day,
 * the total budget and per-service caps since the policy took effect. The
 * engine counts each asset separately against the same number, and so does
 * this.
 */
export function policyUsage(
  hub: ObservabilityHub,
  payers: readonly string[],
  policy: Policy,
  effectiveFrom: string,
  now: number,
): AgentPolicyUsage {
  const day = utcDay(now);
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
  // Lifetime windows end with the current day, in whole UTC days.
  const lifetimeStart = `${effectiveFrom.slice(0, 10)}T00:00:00.000Z`;
  const today = settledRows(hub, payers, { from: dayStart, to: dayEnd }, "1d", "payee");
  const lifetime = settledRows(hub, payers, { from: lifetimeStart, to: dayEnd }, "1d", "payee");
  const all = () => true;

  return {
    document: policy,
    effectiveFrom,
    utcDay: day,
    daily: {
      limit: policy.budgets?.daily ?? null,
      usedByAsset: usedByAsset(today, all),
      windowStart: dayStart,
    },
    total: {
      limit: policy.budgets?.total ?? null,
      usedByAsset: usedByAsset(lifetime, all),
      windowStart: effectiveFrom,
    },
    perService: Object.entries(policy.perService ?? {})
      .filter(([, config]) => config?.cap != null)
      .map(([payee, config]) => ({
        payee,
        limit: config?.cap ?? null,
        usedByAsset: usedByAsset(lifetime, (row) => row.key === payee),
        windowStart: effectiveFrom,
      })),
  };
}

/**
 * A stop as stored: the trace is parsed with the core schema, which rejects
 * an unknown version or a trace whose summary contradicts its entries, and
 * only a trace that blocked is a stop.
 */
export function stopFromTrace(raw: unknown): PolicyStop {
  const trace = policyTraceSchema.parse(raw);
  const blocking = trace.entries.find((entry) => entry.id === trace.blockedBy);
  if (!trace.wouldBlock || blocking === undefined) {
    throw new Error(`policy trace at ${trace.evaluatedAt} did not block, so it is not a stop`);
  }
  return {
    at: trace.evaluatedAt,
    ruleId: blocking.id,
    rule: blocking.rule,
    detail: blocking.detail,
    trace,
  };
}

// ---------------------------------------------------------------------------
// Deterministic stub. Everything below goes when #226 and #228 land.
// ---------------------------------------------------------------------------

/** The stub's clock. Fixed so every render and test sees the same data. */
export const STUB_NOW = Date.parse("2026-11-19T18:30:00.000Z");

type StubPayment = {
  payer: string;
  payee: string;
  model: SettlementModel;
  asset: string;
  amount: string;
  at: string;
  outcome?: PaymentMetric["outcome"];
};

type StubAgent = {
  id: string;
  label: string;
  payerAddresses: string[];
  policy: { document: Policy; effectiveFrom: string } | null;
  payments: StubPayment[];
  /** Payments the policy refused. Each is evaluated by the real engine. */
  blocked: (PaymentIntent & { at: string })[];
};

const STUB_AGENTS: StubAgent[] = [
  {
    id: "agent-research-01",
    label: "research-bot",
    payerAddresses: ["GAGENTRESEARCH1", "GAGENTRESEARCH2"],
    policy: {
      effectiveFrom: "2026-11-01T00:00:00.000Z",
      document: {
        policyVersion: 1,
        budgets: { daily: "5000000000", total: "20000000000" },
        perService: { GSERVICEALPHA: { cap: "10000000000" }, GSERVICEBETA: { cap: "3000000000" } },
        perModel: { "mpp-channel": { enabled: true, minChannelDeposit: "1000000" } },
        rateLimit: { requestsPerMinute: 120 },
        anomaly: { maxSpendPerMinute: "3000000000" },
      },
    },
    payments: [
      {
        payer: "GAGENTRESEARCH1",
        payee: "GSERVICEALPHA",
        model: "x402",
        asset: "USDC",
        amount: "1200000000",
        at: "2026-11-12T09:00:00.000Z",
      },
      {
        payer: "GAGENTRESEARCH1",
        payee: "GSERVICEALPHA",
        model: "x402",
        asset: "USDC",
        amount: "1500000000",
        at: "2026-11-18T09:00:00.000Z",
      },
      {
        payer: "GAGENTRESEARCH1",
        payee: "GSERVICEALPHA",
        model: "x402",
        asset: "USDC",
        amount: "2500000000",
        at: "2026-11-19T10:15:00.000Z",
      },
      {
        payer: "GAGENTRESEARCH2",
        payee: "GSERVICEBETA",
        model: "mpp-channel",
        asset: "XLM",
        amount: "2000000000",
        at: "2026-11-19T11:40:00.000Z",
      },
      {
        payer: "GAGENTRESEARCH1",
        payee: "GSERVICEALPHA",
        model: "mpp-charge",
        asset: "USDC",
        amount: "1000000000",
        at: "2026-11-19T15:05:00.000Z",
      },
      // Failed payments move no money and must not appear in any total.
      {
        payer: "GAGENTRESEARCH1",
        payee: "GSERVICEALPHA",
        model: "x402",
        asset: "USDC",
        amount: "999999999",
        at: "2026-11-19T12:00:00.000Z",
        outcome: "failed",
      },
    ],
    blocked: [
      {
        at: "2026-11-19T16:20:00.000Z",
        payee: "GSERVICEALPHA",
        resource: "/v1/search",
        amount: "2000000000",
        asset: "USDC",
        model: "x402",
      },
      {
        at: "2026-11-19T17:45:00.000Z",
        payee: "GSERVICEBETA",
        resource: "/v1/summarize",
        amount: "1500000000",
        asset: "XLM",
        model: "mpp-channel",
      },
    ],
  },
  {
    id: "agent-summarizer-02",
    label: "summarizer",
    payerAddresses: ["GAGENTSUMMARIZER"],
    policy: null,
    payments: [
      {
        payer: "GAGENTSUMMARIZER",
        payee: "GSERVICEALPHA",
        model: "mpp-charge",
        asset: "USDC",
        amount: "734200000",
        at: "2026-11-19T14:00:00.000Z",
      },
    ],
    blocked: [],
  },
  {
    id: "agent-classifier-03",
    label: "classifier",
    payerAddresses: ["GAGENTCLASSIFIER"],
    policy: {
      effectiveFrom: "2026-11-15T00:00:00.000Z",
      document: {
        policyVersion: 1,
        budgets: { daily: "1000000000" },
        perService: { GSERVICEGAMMA: { cap: "500000000" } },
      },
    },
    payments: [
      {
        payer: "GAGENTCLASSIFIER",
        payee: "GSERVICEGAMMA",
        model: "x402",
        asset: "USDC",
        amount: "215000000",
        at: "2026-11-19T15:00:00.000Z",
      },
    ],
    blocked: [],
  },
  {
    id: "agent-router-04",
    label: "router",
    payerAddresses: ["GAGENTROUTER"],
    policy: {
      effectiveFrom: "2026-11-10T00:00:00.000Z",
      document: {
        policyVersion: 1,
        budgets: { daily: "500000000", total: "1000000000" },
        perService: { GSERVICEDELTA: { cap: "200000000" } },
      },
    },
    payments: [
      {
        payer: "GAGENTROUTER",
        payee: "GSERVICEDELTA",
        model: "mpp-channel",
        asset: "XLM",
        amount: "98000000",
        at: "2026-11-19T16:00:00.000Z",
      },
    ],
    blocked: [],
  },
];

/** Every stub agent's id and label, for the agents list. */
export const stubAgentIds: readonly string[] = STUB_AGENTS.map((agent) => agent.id);

function stubHub(agent: StubAgent): ObservabilityHub {
  const hub = createObservabilityHub();
  for (const payment of agent.payments) {
    hub.record({ ...payment, outcome: payment.outcome ?? "settled", latencyMs: 120 });
  }
  return hub;
}

/**
 * The traces the engine produced when it refused the stub's blocked
 * payments. The engine is replayed over the settled payments in time order,
 * with its clock set to each one, so budgets and caps hold what they held at
 * the moment of the stop.
 */
async function stubStops(agent: StubAgent): Promise<PolicyStop[]> {
  if (agent.policy === null) return [];
  let clock = Date.parse(agent.policy.effectiveFrom);
  const engine = createPolicyEngine(agent.policy.document, { clock: () => clock });
  const settled = agent.payments
    .filter((payment) => (payment.outcome ?? "settled") === "settled")
    .map((payment) => ({ kind: "settled" as const, at: payment.at, payment }));
  const blocked = agent.blocked.map((intent) => ({
    kind: "blocked" as const,
    at: intent.at,
    intent,
  }));
  const timeline = [...settled, ...blocked].sort((left, right) => left.at.localeCompare(right.at));

  const stops: PolicyStop[] = [];
  for (const event of timeline) {
    clock = Date.parse(event.at);
    if (event.kind === "settled") {
      const { payee, model, asset, amount } = event.payment;
      await engine.record({ payee, model, asset, amount, resource: "/stub" });
    } else {
      const { at: _at, ...intent } = event.intent;
      // Round-trip through JSON, as a trace read back from storage would be.
      stops.push(stopFromTrace(JSON.parse(JSON.stringify(await engine.evaluate(intent)))));
    }
  }
  return stops.reverse();
}

export async function fetchAgentDetail(
  agentId: string,
  query: AgentDetailQuery,
  now: number = STUB_NOW,
): Promise<AgentDetail> {
  const agent = STUB_AGENTS.find((candidate) => candidate.id === agentId);
  if (!agent) throw new UnknownAgentError(agentId);

  const hub = stubHub(agent);
  const window = rangeWindow(now, query);
  const bucket = BUCKET_WIDTH[query.bucket].query;
  const byModelRows = settledRows(hub, agent.payerAddresses, window, bucket, "model");
  const byPayeeRows = settledRows(hub, agent.payerAddresses, window, bucket, "payee");

  return {
    id: agent.id,
    label: agent.label,
    payerAddresses: agent.payerAddresses,
    query,
    from: window.from,
    to: window.to,
    series: seriesByAsset(byModelRows),
    byModel: totalsByKey(byModelRows),
    byPayee: totalsByKey(byPayeeRows),
    policy:
      agent.policy === null
        ? null
        : policyUsage(
            hub,
            agent.payerAddresses,
            agent.policy.document,
            agent.policy.effectiveFrom,
            now,
          ),
    recentStops: await stubStops(agent),
  };
}
