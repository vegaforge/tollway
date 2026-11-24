import type { PolicyRuleName } from "@vegaforge/tollway-core";
import type { AnomalyEvent, AnomalyKind } from "@/data/anomalies";
import type { DriftKind } from "@/data/channel-detail";
import { formatAmount, formatBasisPoints } from "./amount";

/**
 * One sentence per policy rule. Typed by `PolicyRuleName`, so a rule added in
 * core without a sentence here fails the typecheck.
 */
export const POLICY_RULE_COPY: Record<PolicyRuleName, string> = {
  "per-model-disabled": "This model is switched off in the agent's policy.",
  "min-channel-deposit": "The channel deposit is below the policy minimum.",
  budget: "The payment would exceed the agent's budget.",
  "per-service": "The payment would exceed the cap for this service.",
  "per-service-daily": "The payment would exceed the daily cap for this service.",
  "per-service-window": "The payment would exceed the windowed cap for this service.",
  "per-resource": "The payment would exceed the cap for this resource.",
  "per-resource-daily": "The payment would exceed the daily cap for this resource.",
  "per-resource-window": "The payment would exceed the windowed cap for this resource.",
  "rate-limit": "The agent sent more payments than its rate limit allows.",
  anomaly: "The policy blocks payments the anomaly check flags.",
  "anomaly-adaptive": "The payment was far outside this agent's usual spend.",
};

/** One sentence per drift kind `@vegaforge/tollway-reconcile` reports. */
export const DRIFT_COPY: Record<DriftKind, string> = {
  "under-settled": "The channel settled less than its last commitment.",
  "over-settled": "The channel settled more than its last commitment.",
  "missing-commitment": "A settlement has no commitment behind it.",
  "unexpected-remainder": "The returned remainder does not match deposit minus commitment.",
  "sequence-gap": "The commitment stream skips a sequence.",
  "malformed-record": "A commitment or settlement record does not parse.",
  "non-monotonic-cumulative": "A cumulative amount falls below an earlier one.",
  "foreign-commitment": "A commitment names a different channel than its settlement.",
  "duplicate-sequence": "Two commitments share one sequence.",
};

export const KIND_LABEL: Record<AnomalyKind, string> = {
  "policy-stop": "Policy stop",
  "spend-spike": "Spend spike",
  "budget-warning": "Budget warning",
  "reconciliation-drift": "Reconciliation drift",
};

/**
 * A one-line explanation built from the event's own fields: which rule or
 * budget fired, its limit, and the amount involved. Amounts are formatted here,
 * since the data layer does not format.
 */
export function describeAnomaly(event: AnomalyEvent): string {
  switch (event.kind) {
    case "policy-stop": {
      const attempted = formatAmount(event.attempted, event.asset);
      const limit = event.limit === null ? null : formatAmount(event.limit, event.asset);
      const limitText = limit === null ? "" : `, limit ${limit}`;
      return `${POLICY_RULE_COPY[event.rule]} Attempted ${attempted}${limitText}.`;
    }
    case "spend-spike": {
      const observed = formatAmount(event.observed, event.asset);
      const expected = formatAmount(event.expected, event.asset);
      const threshold = formatAmount(event.threshold, event.asset);
      return `Spend reached ${observed}, against ${expected} expected. Fires above ${threshold}.`;
    }
    case "budget-warning": {
      const used = formatAmount(event.used, event.asset);
      const limit = formatAmount(event.limit, event.asset);
      const line = formatBasisPoints(BigInt(event.thresholdBasisPoints));
      return `${used} of ${limit} used, past the ${line} warning line.`;
    }
    case "reconciliation-drift":
      return `${DRIFT_COPY[event.drift]} ${event.detail}`;
  }
}

export type AnomalyLink = { label: string; href: string };

/**
 * The drill-downs for an event: the channel for a drift, the receipts paid to
 * the counterparty, and the agent it concerns. Each is shown only when the
 * event carries what it needs.
 */
export function anomalyLinks(event: AnomalyEvent): AnomalyLink[] {
  const links: AnomalyLink[] = [];
  if (event.channelId !== null) {
    links.push({ label: "Channel", href: `/channels/${encodeURIComponent(event.channelId)}` });
  }
  if (event.payee !== null) {
    links.push({
      label: "Receipts to this counterparty",
      href: `/receipts?payee=${encodeURIComponent(event.payee)}`,
    });
  }
  if (event.agentId !== null) {
    links.push({ label: "Agent", href: `/agents/${encodeURIComponent(event.agentId)}` });
  }
  return links;
}
