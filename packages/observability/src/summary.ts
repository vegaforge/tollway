import type { SettlementModel } from "@vegaforge/tollway-core";
import type {
  ModelAssetSpend,
  PayeeAssetSpend,
  PayerAssetSpend,
  PaymentMetric,
  SpendOutcomeCounts,
  SpendSummary,
} from "./metrics.js";

/**
 * The spend-summary rules, shared by the hub and every metrics store so they
 * cannot drift apart. Only metrics with outcome `"settled"` add to an amount:
 * a failed or skipped payment moves no money. `count` and `byOutcome` count
 * every matched metric. Amounts are summed with bigint and amounts in
 * different assets are never added together.
 */

// One group of a per-asset breakdown while it is being summed.
type AssetTotal<K extends string> = Record<K, string> & {
  asset: string;
  amount: bigint;
  count: number;
};

type SummaryMetric = Pick<
  PaymentMetric,
  "payer" | "payee" | "model" | "amount" | "asset" | "outcome"
>;

function bump<K extends string>(
  groups: Map<string, AssetTotal<K>>,
  field: K,
  label: string,
  asset: string,
  amount: bigint,
): void {
  // JSON of an array cannot collide for different field values, unlike a
  // join on a separator that may appear inside an asset code.
  const key = JSON.stringify([label, asset]);
  const total = groups.get(key);
  if (total) {
    total.amount += amount;
    total.count += 1;
    return;
  }
  groups.set(key, { [field]: label, asset, amount, count: 1 } as AssetTotal<K>);
}

/** Asset first, then the group's label, so output order never depends on input order. */
function sorted<K extends string>(groups: Map<string, AssetTotal<K>>, field: K) {
  return [...groups.values()]
    .sort((a, b) => {
      if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
      if (a[field] === b[field]) return 0;
      return a[field] < b[field] ? -1 : 1;
    })
    .map((total) => ({ ...total, amount: total.amount.toString() }));
}

function strings(source: Map<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of source) out[key] = value.toString();
  return out;
}

/** Builds a {@link SpendSummary} one metric at a time. */
export class SummaryAccumulator {
  private total = 0n;
  private count = 0;
  private readonly byOutcome: SpendOutcomeCounts = { settled: 0, failed: 0, skipped: 0 };
  private readonly byAsset = new Map<string, bigint>();
  private readonly byModel = new Map<string, bigint>();
  private readonly byPayer = new Map<string, bigint>();
  private readonly byPayee = new Map<string, bigint>();
  private readonly modelAsset = new Map<string, AssetTotal<"model">>();
  private readonly payerAsset = new Map<string, AssetTotal<"payer">>();
  private readonly payeeAsset = new Map<string, AssetTotal<"payee">>();

  add(metric: SummaryMetric): void {
    this.count += 1;
    if (
      metric.outcome === "settled" ||
      metric.outcome === "failed" ||
      metric.outcome === "skipped"
    ) {
      this.byOutcome[metric.outcome] += 1;
    }
    // A payment that did not settle moves no money, so it never adds to spend.
    if (metric.outcome !== "settled") return;
    // A settled metric with a non-integer amount cannot be summed safely. It
    // still counts as an attempt above and is visible through export(). Only
    // the in-memory hub can hold one: every store validates amounts on write.
    if (!/^[0-9]+$/.test(metric.amount)) return;
    const amount = BigInt(metric.amount);
    this.total += amount;
    add(this.byAsset, metric.asset, amount);
    add(this.byModel, metric.model, amount);
    add(this.byPayer, metric.payer, amount);
    add(this.byPayee, metric.payee, amount);
    bump(this.modelAsset, "model", metric.model, metric.asset, amount);
    bump(this.payerAsset, "payer", metric.payer, metric.asset, amount);
    bump(this.payeeAsset, "payee", metric.payee, metric.asset, amount);
  }

  result(): SpendSummary {
    return {
      totalAmount: this.total.toString(),
      count: this.count,
      byOutcome: { ...this.byOutcome },
      byAsset: strings(this.byAsset),
      byModel: strings(this.byModel) as Partial<Record<SettlementModel, string>>,
      byPayer: strings(this.byPayer),
      byPayee: strings(this.byPayee),
      byModelAsset: sorted(this.modelAsset, "model") as ModelAssetSpend[],
      byPayerAsset: sorted(this.payerAsset, "payer") as PayerAssetSpend[],
      byPayeeAsset: sorted(this.payeeAsset, "payee") as PayeeAssetSpend[],
    };
  }
}

function add(map: Map<string, bigint>, key: string, amount: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

/** Summarizes metrics already filtered by a query. */
export function summarizeMetrics(matched: readonly SummaryMetric[]): SpendSummary {
  const summary = new SummaryAccumulator();
  for (const metric of matched) summary.add(metric);
  return summary.result();
}
