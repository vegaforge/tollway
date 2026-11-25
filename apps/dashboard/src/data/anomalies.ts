/**
 * Typed data layer for the anomalies feed (`/anomalies`).
 *
 * The feed is a list of events. The view does not run policy or
 * reconciliation itself. Each variant maps to one real source:
 *
 * - `policy-stop`: a blocking entry in a policy trace from
 *   `@vegaforge/tollway-core` (`PolicyEngine.check`). The rule names are
 *   `policyRuleNames`.
 * - `spend-spike`: the `anomaly.detected` event from
 *   `@vegaforge/tollway-observability`, which adaptive detection (#196) emits.
 * - `budget-warning`: the `budget.warning` event from
 *   `@vegaforge/tollway-observability`, which fires at a budget threshold (#195).
 * - `reconciliation-drift`: a drift from `Reconciler.reconcileChannel` in
 *   `@vegaforge/tollway-reconcile`. Its kinds are `DRIFT_KINDS`.
 *
 * Amounts are integer strings in the asset's smallest unit. The view formats
 * them. The stub stands in for the event stream that #238 will deliver live.
 * Keep the hook's shape compatible with appending new events.
 */

import { type PolicyRuleName, policyRuleNames } from "@vegaforge/tollway-core";
import { DRIFT_KINDS, type DriftKind } from "./channel-detail";

export const ANOMALY_KINDS = [
  "policy-stop",
  "spend-spike",
  "budget-warning",
  "reconciliation-drift",
] as const;

export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** `high` for a policy stop or a drift, `medium` for a warning or a spike. */
export type AnomalySeverity = "high" | "medium";

type AnomalyBase = {
  id: string;
  /** ISO-8601 time the event fired. */
  at: string;
  /** The agent the event concerns, when the source knows it. */
  agentId: string | null;
  payer: string | null;
  /** The payee, or the counterparty for a drift. */
  payee: string | null;
  asset: string;
  /** Receipts behind the event. Empty when no payment settled. */
  receiptIds: string[];
  /** The channel a drift concerns. */
  channelId: string | null;
};

export type AnomalyEvent =
  | (AnomalyBase & {
      kind: "policy-stop";
      rule: PolicyRuleName;
      /** The amount the blocked payment asked for. */
      attempted: string;
      /** The limit the rule enforces, or null for a rule with no amount limit. */
      limit: string | null;
    })
  | (AnomalyBase & {
      kind: "spend-spike";
      /** The spend in the window that tripped the detector. */
      observed: string;
      /** What the detector expected for the window. */
      expected: string;
      /** The amount above which the detector fires. */
      threshold: string;
    })
  | (AnomalyBase & {
      kind: "budget-warning";
      used: string;
      limit: string;
      /** The share of the limit that fired the warning, in basis points. */
      thresholdBasisPoints: number;
    })
  | (AnomalyBase & {
      kind: "reconciliation-drift";
      drift: DriftKind;
      detail: string;
    });

/** The severity a kind carries. Derived, so a feed never disagrees with itself. */
export function severityOf(kind: AnomalyKind): AnomalySeverity {
  return kind === "policy-stop" || kind === "reconciliation-drift" ? "high" : "medium";
}

export type AnomalyQuery = {
  kind?: AnomalyKind;
  severity?: AnomalySeverity;
  /** Matches the payee, which is the counterparty for a drift. */
  counterparty?: string;
  /** Matches the events that concern one agent. */
  agentId?: string;
  /** The id of the last event on the previous page, or null for the first page. */
  cursor?: string | null;
  limit?: number;
};

export type AnomalyPage = {
  /** Newest first. */
  events: AnomalyEvent[];
  /** Pass to the next query to load the page after this one, or null at the end. */
  nextCursor: string | null;
};

export const DEFAULT_ANOMALY_PAGE_SIZE = 10;

/**
 * Loads one page of the feed. The filters apply first, then the cursor picks
 * up after the event it names, so a page never repeats or skips one. A cursor
 * the feed does not know throws, rather than restarting from the top.
 */
export async function fetchAnomalies(query: AnomalyQuery = {}): Promise<AnomalyPage> {
  const limit = query.limit ?? DEFAULT_ANOMALY_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(`limit must be a whole number from 1 to 100, got ${limit}`);
  }

  const matching = STUB_EVENTS.filter(
    (event) =>
      (query.kind === undefined || event.kind === query.kind) &&
      (query.severity === undefined || severityOf(event.kind) === query.severity) &&
      (query.counterparty === undefined || event.payee === query.counterparty) &&
      (query.agentId === undefined || event.agentId === query.agentId),
  );

  let start = 0;
  if (query.cursor !== undefined && query.cursor !== null) {
    const after = query.cursor;
    const index = matching.findIndex((event) => event.id === after);
    if (index === -1) throw new RangeError(`cursor "${after}" is not in this feed`);
    start = index + 1;
  }

  const events = matching.slice(start, start + limit);
  const hasMore = start + limit < matching.length;
  return { events, nextCursor: hasMore ? (events.at(-1)?.id ?? null) : null };
}

/** Every counterparty the feed names, for the counterparty filter, in order. */
export function anomalyCounterparties(): string[] {
  const names = new Set<string>();
  for (const event of STUB_EVENTS) {
    if (event.payee !== null) names.add(event.payee);
  }
  return [...names].sort();
}

// ── stub data ─────────────────────────────────────────────────────────────────
//
// One event for every policy rule, every drift kind, and a few spend spikes
// and budget warnings. Times step back one hour each, so the list is newest
// first by construction.

const NEWEST_MS = Date.parse("2026-11-24T10:00:00.000Z");

const AGENT_RESEARCH = "agent-research-01";
const AGENT_CLASSIFIER = "agent-classifier-03";
const PAYER = "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const STRIPE = "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OPENAI = "GOPENAIXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const ANTHROPIC = "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/** Rules that compare a payment with a cap, so they carry a limit. */
const LIMITED_RULES: ReadonlySet<PolicyRuleName> = new Set([
  "budget",
  "per-service",
  "per-service-daily",
  "per-service-window",
  "per-resource",
  "per-resource-daily",
  "per-resource-window",
]);

function buildStub(): AnomalyEvent[] {
  const events: AnomalyEvent[] = [];
  let index = 0;
  const base = (kind: string): AnomalyBase => {
    const at = new Date(NEWEST_MS - index * 3_600_000).toISOString();
    const id = `anom-${kind}-${index}`;
    index += 1;
    return {
      id,
      at,
      agentId: null,
      payer: null,
      payee: null,
      asset: "USDC",
      receiptIds: [],
      channelId: null,
    };
  };

  for (const rule of policyRuleNames) {
    events.push({
      ...base("policy-stop"),
      kind: "policy-stop",
      agentId: AGENT_RESEARCH,
      payer: PAYER,
      payee: STRIPE,
      rule,
      attempted: "5000000",
      limit: LIMITED_RULES.has(rule) ? "2500000000" : null,
    });
  }

  for (let i = 0; i < 3; i += 1) {
    events.push({
      ...base("spend-spike"),
      kind: "spend-spike",
      agentId: AGENT_CLASSIFIER,
      payer: PAYER,
      payee: OPENAI,
      observed: `${9_000_000 + i * 1_000_000}`,
      expected: "2000000",
      threshold: "6000000",
      receiptIds: ["rcpt-channel-openai-01"],
    });
  }

  for (let i = 0; i < 3; i += 1) {
    events.push({
      ...base("budget-warning"),
      kind: "budget-warning",
      agentId: AGENT_RESEARCH,
      payer: PAYER,
      used: `${4_000_000_000 + i * 100_000_000}`,
      limit: "5000000000",
      thresholdBasisPoints: 8000,
    });
  }

  for (const drift of DRIFT_KINDS) {
    events.push({
      ...base("reconciliation-drift"),
      kind: "reconciliation-drift",
      payee: ANTHROPIC,
      channelId: "ch-drift-06",
      drift,
      detail: `Reconciliation of ch-drift-06 reported ${drift}.`,
    });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}

const STUB_EVENTS: AnomalyEvent[] = buildStub();
