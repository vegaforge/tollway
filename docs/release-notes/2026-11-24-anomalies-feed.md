---
date: 2026-11-24
feature: Anomalies feed of policy stops, spend spikes, budget warnings and reconciliation drift
scope: feat
packages: ["@vegaforge/tollway-dashboard"]
scenario-impact: none
---

# Anomalies feed

`/anomalies` lists policy stops, spend spikes, budget warnings and reconciliation drift, newest first and grouped by UTC day. Each event has a one-line explanation built from its own fields (the rule or budget that fired, its limit, and the amount involved), a severity shown as text (drift and policy stops are high, warnings and spikes are medium), and links to the channel, the receipts paid to the counterparty, or the agent it concerns.

The feed filters by kind, severity, and counterparty, and pages with a cursor. The agent detail page's link to `?agent=<id>` now filters the feed to that agent. The Overview shows the three newest events from the same hook.

The event types mirror the real sources: policy trace stops, the `anomaly.detected` and `budget.warning` webhook events, and reconciler drift. The stub data covers every policy rule and every drift kind. The explanations are typed over those lists, so a new kind without a sentence fails the typecheck.
