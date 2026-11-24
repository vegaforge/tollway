/**
 * Typed data layer for the Overview page (`/`).
 *
 * The Overview reads four things: settled spend per asset, payment outcomes,
 * open channels with their remaining budget, and the newest receipts. Spend
 * comes from `@vegaforge/tollway-observability`, through the same `record` and
 * `summarize` calls the hub serves. The hub counts only settled payments
 * toward an amount and keeps each asset apart, so this page cannot add a
 * failed payment to spend or add USDC to XLM. Channels and receipts come
 * from the existing seams in this directory.
 *
 * Replacing the stub payments with the hub's real feed changes `fetchOverview`
 * and nothing downstream.
 */

import {
  createObservabilityHub,
  type PaymentMetric,
  type SpendSummary,
} from "@vegaforge/tollway-observability";
import { fetchOpenChannels, type OpenChannelRow } from "./open-channels";
import { fetchReceipts, type ReceiptRow } from "./receipts";

/** The part of a hub summary the Overview reads. */
export type OverviewSpend = Pick<SpendSummary, "count" | "byOutcome" | "byAsset" | "byModelAsset">;

export type OverviewSnapshot = {
  /** The window the figures cover, `[from, to)` in UTC. */
  period: { from: string; to: string };
  spend: OverviewSpend;
  /** Every channel the source tracks. The page counts the ones that are open. */
  channels: OpenChannelRow[];
  /** The newest receipts, newest first. */
  recentReceipts: ReceiptRow[];
};

/** How many receipts the recent-receipts strip shows. */
export const RECENT_RECEIPT_COUNT = 5;

/**
 * Loads the Overview. Resolves the summary the hub computes over the stub's
 * payments, the channels, and the newest receipts.
 */
export async function fetchOverview(): Promise<OverviewSnapshot> {
  const [channels, receipts] = await Promise.all([fetchOpenChannels(), fetchReceipts()]);

  const hub = createObservabilityHub();
  for (const metric of STUB_PAYMENTS) hub.record(metric);
  const spend = hub.summarize({ from: STUB_PERIOD.from, to: STUB_PERIOD.to });

  const recentReceipts = [...receipts.rows]
    .sort((a, b) => b.receipt.issuedAt.localeCompare(a.receipt.issuedAt))
    .slice(0, RECENT_RECEIPT_COUNT);

  return {
    period: STUB_PERIOD,
    spend,
    channels: channels.rows,
    recentReceipts,
  };
}

/**
 * Failed payments over attempted payments, as basis points. Attempted means
 * settled or failed. A skipped payment was never sent, so it is not in the
 * denominator. Returns null when nothing was attempted, so the page can say
 * so instead of showing 0% or NaN.
 */
export function failureRateBasisPoints(byOutcome: OverviewSpend["byOutcome"]): bigint | null {
  const attempted = byOutcome.settled + byOutcome.failed;
  if (attempted === 0) return null;
  return (BigInt(byOutcome.failed) * 10_000n) / BigInt(attempted);
}

/** Remaining budget per asset across the open channels, as integer strings. */
export function remainingByAsset(
  channels: readonly OpenChannelRow[],
): { asset: string; amount: string }[] {
  const totals = new Map<string, bigint>();
  for (const channel of channels) {
    if (channel.status !== "open") continue;
    const remaining = BigInt(channel.deposit) - BigInt(channel.committed);
    totals.set(channel.asset, (totals.get(channel.asset) ?? 0n) + remaining);
  }
  return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}

// ── stub data ─────────────────────────────────────────────────────────────────
//
// Two assets, all three models, every outcome, and a model with no XLM
// spend, so the model mix shows a zero share rather than a gap.

const STUB_PERIOD = {
  from: "2026-11-17T00:00:00.000Z",
  to: "2026-11-25T00:00:00.000Z",
} as const;

const PAYER = "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const STRIPE = "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const ANTHROPIC = "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OPENAI = "GOPENAIXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const STUB_PAYMENTS: PaymentMetric[] = [
  payment("x402", STRIPE, "USDC", "settled", "1200000", "2026-11-20T10:00:00.000Z"),
  payment("x402", STRIPE, "USDC", "settled", "120000", "2026-11-21T09:00:00.000Z"),
  payment("x402", STRIPE, "USDC", "failed", "120000", "2026-11-21T09:30:00.000Z"),
  payment("mpp-charge", ANTHROPIC, "USDC", "settled", "7500000", "2026-11-22T08:00:00.000Z"),
  payment("mpp-charge", ANTHROPIC, "USDC", "skipped", "7500000", "2026-11-22T08:10:00.000Z"),
  payment("mpp-channel", ANTHROPIC, "USDC", "settled", "85000000", "2026-11-23T07:00:00.000Z"),
  payment("mpp-channel", OPENAI, "USDC", "settled", "41000000", "2026-11-23T11:00:00.000Z"),
  payment("mpp-channel", OPENAI, "USDC", "failed", "41000000", "2026-11-24T06:00:00.000Z"),
  payment("x402", STRIPE, "XLM", "settled", "30000000", "2026-11-22T12:00:00.000Z"),
  payment("mpp-charge", OPENAI, "XLM", "failed", "5000000", "2026-11-23T15:00:00.000Z"),
  payment("x402", STRIPE, "XLM", "settled", "12500000", "2026-11-24T04:00:00.000Z"),
];

function payment(
  model: PaymentMetric["model"],
  payee: string,
  asset: string,
  outcome: PaymentMetric["outcome"],
  amount: string,
  at: string,
): PaymentMetric {
  return { payer: PAYER, payee, model, asset, outcome, amount, at, latencyMs: 120 };
}
