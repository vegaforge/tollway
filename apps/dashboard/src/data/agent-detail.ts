import type { Policy } from "@vegaforge/tollway-core";

export type Bucket = "hour" | "day";

export type SettledMetric = {
  payer: string;
  payee: string;
  model: string;
  amount: string;
  asset: string;
  outcome: "settled" | "failed" | "skipped";
  at: string;
};

export type SeriesPoint = { bucket: string; amount: string };
export type AssetSeries = { asset: string; points: SeriesPoint[] };
export type SeriesByBucket = { bucket: Bucket; assets: AssetSeries[] };
export type AmountByKey = { key: string; asset: string; amount: string };

export type BudgetUsage = {
  budget: string | null;
  usedByAsset: { asset: string; amount: string }[];
};

export type ServiceCapUsage = {
  payee: string;
  cap: string | null;
  usedByAsset: { asset: string; amount: string }[];
};

export type AgentPolicyUsage = {
  document: Policy;
  daily: BudgetUsage;
  total: BudgetUsage;
  perService: ServiceCapUsage[];
};

export type PolicyStop = { at: string; rule: string; detail: string };

export type AgentDetail = {
  id: string;
  label: string;
  payerAddresses: string[];
  series: SeriesByBucket[];
  byModel: AmountByKey[];
  byPayee: AmountByKey[];
  policy: AgentPolicyUsage | null;
  recentStops: PolicyStop[];
};

const BASIS_POINTS = 10_000n;
const STUB_TODAY = "2026-11-19";

export function percentageBasisPoints(used: bigint, budget: bigint): bigint {
  if (budget <= 0n) return used <= 0n ? 0n : BASIS_POINTS;
  return (used * BASIS_POINTS) / budget;
}

function bucketKey(at: string, bucket: Bucket): string {
  const iso = new Date(at).toISOString();
  return bucket === "hour" ? iso.slice(0, 13) : iso.slice(0, 10);
}

export function bucketSeries(metrics: SettledMetric[], bucket: Bucket): SeriesPoint[] {
  const totals = new Map<string, bigint>();
  for (const metric of metrics) {
    if (metric.outcome !== "settled") continue;
    const key = bucketKey(metric.at, bucket);
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(metric.amount));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, amount]) => ({ bucket: key, amount: amount.toString() }));
}

export function seriesByAsset(metrics: SettledMetric[], bucket: Bucket): AssetSeries[] {
  const byAsset = new Map<string, SettledMetric[]>();
  for (const metric of metrics) {
    if (metric.outcome !== "settled") continue;
    const list = byAsset.get(metric.asset) ?? [];
    list.push(metric);
    byAsset.set(metric.asset, list);
  }
  return [...byAsset.entries()].map(([asset, assetMetrics]) => ({
    asset,
    points: bucketSeries(assetMetrics, bucket),
  }));
}

function sumByAsset(metrics: SettledMetric[]): { asset: string; amount: string }[] {
  const totals = new Map<string, bigint>();
  for (const metric of metrics) {
    if (metric.outcome !== "settled") continue;
    totals.set(metric.asset, (totals.get(metric.asset) ?? 0n) + BigInt(metric.amount));
  }
  return [...totals.entries()].map(([asset, amount]) => ({
    asset,
    amount: amount.toString(),
  }));
}

function sumByKey(metrics: SettledMetric[], key: "model" | "payee"): AmountByKey[] {
  const totals = new Map<string, bigint>();
  for (const metric of metrics) {
    if (metric.outcome !== "settled") continue;
    const id = `${metric[key]}:${metric.asset}`;
    totals.set(id, (totals.get(id) ?? 0n) + BigInt(metric.amount));
  }
  return [...totals.entries()].map(([id, amount]) => {
    const separator = id.lastIndexOf(":");
    return {
      key: id.slice(0, separator),
      asset: id.slice(separator + 1),
      amount: amount.toString(),
    };
  });
}

type AgentSeed = {
  id: string;
  label: string;
  payerAddresses: string[];
  metrics: SettledMetric[];
  policy: Policy | null;
  stops: PolicyStop[];
};

function metric(
  payer: string,
  payee: string,
  model: string,
  asset: string,
  amount: string,
  at: string,
  outcome: SettledMetric["outcome"] = "settled",
): SettledMetric {
  return { payer, payee, model, asset, amount, at, outcome };
}

function budgetUsage(
  policy: Policy,
  metrics: SettledMetric[],
  scope: "daily" | "total",
): BudgetUsage {
  const inWindow =
    scope === "daily" ? metrics.filter((m) => m.at.slice(0, 10) === STUB_TODAY) : metrics;
  return {
    budget: scope === "daily" ? (policy.budgets?.daily ?? null) : (policy.budgets?.total ?? null),
    usedByAsset: sumByAsset(inWindow),
  };
}

function buildDetail(seed: AgentSeed): AgentDetail {
  const policy = seed.policy;
  return {
    id: seed.id,
    label: seed.label,
    payerAddresses: seed.payerAddresses,
    series: [
      { bucket: "day", assets: seriesByAsset(seed.metrics, "day") },
      { bucket: "hour", assets: seriesByAsset(seed.metrics, "hour") },
    ],
    byModel: sumByKey(seed.metrics, "model"),
    byPayee: sumByKey(seed.metrics, "payee"),
    policy:
      policy === null
        ? null
        : {
            document: policy,
            daily: budgetUsage(policy, seed.metrics, "daily"),
            total: budgetUsage(policy, seed.metrics, "total"),
            perService: Object.entries(policy.perService ?? {}).map(([payee, config]) => ({
              payee,
              cap: config?.cap ?? null,
              usedByAsset: sumByAsset(
                seed.metrics.filter((m) => m.payee === payee && m.at.slice(0, 10) === STUB_TODAY),
              ),
            })),
          },
    recentStops: seed.stops,
  };
}

const STUB_SEEDS: AgentSeed[] = [
  {
    id: "agent-research-01",
    label: "research-bot",
    payerAddresses: ["GAGENT1", "GAGENT2"],
    metrics: [
      metric("GAGENT1", "GSERVICE1", "x402", "USDC", "5000000000", "2026-11-19T10:15:00.000Z"),
      metric(
        "GAGENT2",
        "GSERVICE2",
        "mpp-channel",
        "XLM",
        "2000000000",
        "2026-11-19T11:40:00.000Z",
      ),
      metric("GAGENT1", "GSERVICE1", "x402", "USDC", "120000000", "2026-11-18T09:00:00.000Z"),
      metric(
        "GAGENT1",
        "GSERVICE1",
        "x402",
        "USDC",
        "999999999",
        "2026-11-19T12:00:00.000Z",
        "failed",
      ),
    ],
    policy: {
      budgets: { daily: "5000000000", total: "20000000000" },
      perService: { GSERVICE1: { cap: "6000000000" }, GSERVICE2: { cap: "3000000000" } },
      perModel: { "mpp-channel": { enabled: true, minChannelDeposit: "1000000" } },
      rateLimit: { requestsPerMinute: 120 },
      anomaly: { maxSpendPerMinute: "1000000000" },
    },
    stops: [
      {
        at: "2026-11-19T10:20:00.000Z",
        rule: "budget",
        detail: "daily budget exceeded for USDC",
      },
      {
        at: "2026-11-19T11:45:00.000Z",
        rule: "anomaly",
        detail: "projected minute spend exceeds max for XLM",
      },
    ],
  },
  {
    id: "agent-summarizer-02",
    label: "summarizer",
    payerAddresses: ["GAGENT3"],
    metrics: [
      metric("GAGENT3", "GSERVICE1", "mpp-charge", "USDC", "734200000", "2026-11-19T14:00:00.000Z"),
    ],
    policy: null,
    stops: [],
  },
  {
    id: "agent-classifier-03",
    label: "classifier",
    payerAddresses: ["GAGENT4"],
    metrics: [
      metric("GAGENT4", "GSERVICE3", "x402", "USDC", "215000000", "2026-11-19T15:00:00.000Z"),
    ],
    policy: {
      budgets: { daily: "1000000000" },
      perService: { GSERVICE3: { cap: "500000000" } },
    },
    stops: [],
  },
  {
    id: "agent-router-04",
    label: "router",
    payerAddresses: ["GAGENT5"],
    metrics: [
      metric("GAGENT5", "GSERVICE4", "mpp-channel", "XLM", "98000000", "2026-11-19T16:00:00.000Z"),
    ],
    policy: {
      budgets: { daily: "500000000", total: "1000000000" },
      perService: { GSERVICE4: { cap: "200000000" } },
    },
    stops: [],
  },
];

export async function fetchAgentDetail(agentId: string): Promise<AgentDetail> {
  const seed = STUB_SEEDS.find((candidate) => candidate.id === agentId);
  if (!seed) throw new Error(`unknown agent: ${agentId}`);
  return buildDetail(seed);
}
