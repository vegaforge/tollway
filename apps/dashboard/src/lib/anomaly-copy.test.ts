import { policyRuleNames } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";

import type { AnomalyEvent } from "@/data/anomalies";
import { DRIFT_KINDS } from "@/data/channel-detail";
import {
  anomalyLinks,
  describeAnomaly,
  DRIFT_COPY,
  KIND_LABEL,
  POLICY_RULE_COPY,
} from "./anomaly-copy";

const base = {
  id: "anom-test-0",
  at: "2026-11-24T10:00:00.000Z",
  agentId: null,
  payer: null,
  payee: null,
  asset: "USDC",
  receiptIds: [],
  channelId: null,
};

describe("explanations cover every value the feed can produce", () => {
  it("has one policy-rule sentence for every rule core reports", () => {
    expect(Object.keys(POLICY_RULE_COPY).sort()).toEqual([...policyRuleNames].sort());
  });

  it("has one drift sentence for every drift kind reconcile reports", () => {
    expect(Object.keys(DRIFT_COPY).sort()).toEqual([...DRIFT_KINDS].sort());
  });

  it("names every kind", () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual([
      "budget-warning",
      "policy-stop",
      "reconciliation-drift",
      "spend-spike",
    ]);
  });
});

describe("describeAnomaly", () => {
  it("explains a capped policy stop with the attempted amount and the limit", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "policy-stop",
      rule: "per-service",
      attempted: "5000000",
      limit: "2500000000",
    };

    expect(describeAnomaly(event)).toBe(
      "The payment would exceed the cap for this service. Attempted 0.50 USDC, limit 250.00 USDC.",
    );
  });

  it("omits the limit for a rule with no amount limit", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "policy-stop",
      rule: "per-model-disabled",
      attempted: "5000000",
      limit: null,
    };

    expect(describeAnomaly(event)).toBe(
      "This model is switched off in the agent's policy. Attempted 0.50 USDC.",
    );
  });

  it("explains a budget warning with its share of the limit", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "budget-warning",
      used: "4000000000",
      limit: "5000000000",
      thresholdBasisPoints: 8000,
    };

    expect(describeAnomaly(event)).toBe(
      "400.00 USDC of 500.00 USDC used, past the 80.00% warning line.",
    );
  });

  it("explains a spend spike against the expected spend", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "spend-spike",
      observed: "9000000",
      expected: "2000000",
      threshold: "6000000",
    };

    expect(describeAnomaly(event)).toBe(
      "Spend reached 0.90 USDC, against 0.20 USDC expected. Fires above 0.60 USDC.",
    );
  });

  it("explains a drift with its sentence and the detail the reconciler gave", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "reconciliation-drift",
      drift: "sequence-gap",
      detail: "Sequence 4 is missing from the stream.",
      channelId: "ch-drift-06",
    };

    expect(describeAnomaly(event)).toBe(
      `${DRIFT_COPY["sequence-gap"]} Sequence 4 is missing from the stream.`,
    );
  });
});

describe("anomalyLinks", () => {
  it("links a drift to its channel and to the receipts paid to its counterparty", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "reconciliation-drift",
      drift: "under-settled",
      detail: "d",
      channelId: "ch-drift-06",
      payee: "GANTHROPIC",
    };

    expect(anomalyLinks(event)).toEqual([
      { label: "Channel", href: "/channels/ch-drift-06" },
      { label: "Receipts to this counterparty", href: "/receipts?payee=GANTHROPIC" },
    ]);
  });

  it("links an agent's event to the agent, and omits links it cannot follow", () => {
    const event: AnomalyEvent = {
      ...base,
      kind: "budget-warning",
      used: "1",
      limit: "2",
      thresholdBasisPoints: 8000,
      agentId: "agent-research-01",
    };

    expect(anomalyLinks(event)).toEqual([{ label: "Agent", href: "/agents/agent-research-01" }]);
  });
});
