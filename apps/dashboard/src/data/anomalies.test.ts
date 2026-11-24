import { policyRuleNames } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";

import {
  anomalyCounterparties,
  type AnomalyEvent,
  DEFAULT_ANOMALY_PAGE_SIZE,
  fetchAnomalies,
  severityOf,
} from "./anomalies";
import { DRIFT_KINDS } from "./channel-detail";

const ANTHROPIC = anomalyCounterparties().find((name) => name.startsWith("GANTHROPIC")) ?? "";

/** Walks every page of a query, following the cursor until the feed ends. */
async function allEvents(query: Parameters<typeof fetchAnomalies>[0] = {}) {
  const events: AnomalyEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchAnomalies({ ...query, cursor, limit: DEFAULT_ANOMALY_PAGE_SIZE });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return events;
}

describe("fetchAnomalies", () => {
  it("returns the newest page first, with a cursor while more events remain", async () => {
    const page = await fetchAnomalies();
    const times = page.events.map((event) => event.at);

    expect(page.events).toHaveLength(DEFAULT_ANOMALY_PAGE_SIZE);
    expect(times).toEqual([...times].sort((a, b) => b.localeCompare(a)));
    expect(page.nextCursor).toBe(page.events.at(-1)?.id);
  });

  it("pages through the whole feed once, with no repeats and no gaps", async () => {
    const events = await allEvents();
    const ids = events.map((event) => event.id);

    expect(new Set(ids).size).toBe(ids.length);
    // One event for each of the 12 policy rules, 3 spikes, 3 budget warnings and 9 drifts.
    expect(ids).toHaveLength(policyRuleNames.length + 3 + 3 + DRIFT_KINDS.length);
  });

  it("covers every policy rule and every drift kind, so the explanations are all exercised", async () => {
    const events = await allEvents();
    const rules = new Set(
      events.flatMap((event) => (event.kind === "policy-stop" ? [event.rule] : [])),
    );
    const drifts = new Set(
      events.flatMap((event) => (event.kind === "reconciliation-drift" ? [event.drift] : [])),
    );

    expect([...rules].sort()).toEqual([...policyRuleNames].sort());
    expect([...drifts].sort()).toEqual([...DRIFT_KINDS].sort());
  });

  it("filters by kind", async () => {
    const drifts = await allEvents({ kind: "reconciliation-drift" });

    expect(drifts).toHaveLength(DRIFT_KINDS.length);
    expect(drifts.every((event) => event.kind === "reconciliation-drift")).toBe(true);
  });

  it("filters by severity, where drift and policy stops are high and warnings are medium", async () => {
    const medium = await allEvents({ severity: "medium" });

    expect(medium.map((event) => event.kind).sort()).toEqual([
      "budget-warning",
      "budget-warning",
      "budget-warning",
      "spend-spike",
      "spend-spike",
      "spend-spike",
    ]);
    expect(severityOf("policy-stop")).toBe("high");
    expect(severityOf("reconciliation-drift")).toBe("high");
    expect(severityOf("budget-warning")).toBe("medium");
  });

  it("filters by counterparty, using the drift's counterparty as its payee", async () => {
    const anthropic = await allEvents({ counterparty: ANTHROPIC });

    expect(anthropic.every((event) => event.payee === ANTHROPIC)).toBe(true);
    expect(anthropic.filter((event) => event.kind === "reconciliation-drift")).toHaveLength(
      DRIFT_KINDS.length,
    );
  });

  it("filters to one agent", async () => {
    const classifier = await allEvents({ agentId: "agent-classifier-03" });

    expect(classifier).toHaveLength(3);
    expect(classifier.every((event) => event.kind === "spend-spike")).toBe(true);
  });

  it("rejects a cursor the feed does not know, rather than restarting from the top", async () => {
    await expect(fetchAnomalies({ cursor: "anom-not-real" })).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects a page size outside 1 to 100", async () => {
    await expect(fetchAnomalies({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchAnomalies({ limit: 101 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchAnomalies({ limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });

  it("ends the cursor at the last page", async () => {
    const page = await fetchAnomalies({ limit: 100 });

    expect(page.nextCursor).toBeNull();
  });
});

describe("anomalyCounterparties", () => {
  it("lists each named counterparty once, sorted", () => {
    const names = anomalyCounterparties();

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    expect(names).toContain(ANTHROPIC);
  });
});
