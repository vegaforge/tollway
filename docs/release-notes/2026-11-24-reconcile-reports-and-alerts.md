---
date: 2026-11-24
feature: Reconciliation JSON/CSV reports and deduplicated drift alert bridge
scope: feat
packages: ["@vegaforge/tollway-reconcile"]
scenario-impact: none
---

# Reconciliation reports and drift alerts

`@vegaforge/tollway-reconcile` now turns `ReconciliationResult[]` into versioned JSON reports, RFC 4180 CSV exports with spreadsheet formula-injection neutralization, and deduplicated `anomaly.detected` alert events.

`buildReconciliationReport` aggregates outcome and drift-kind counts (and optional `bigint`-summed integer-string amounts) into a version `1` report, `reconciliationReportToCsv` / `exportReconciliationReport` serialize one row per drift item, and `createDriftAlertBridge` emits `anomaly.detected` events with configurable per-kind severities, store-backed deduplication, and delivery failure isolation. Related issue: #215.

A drift whose `emit` call throws is not recorded as alerted, so the next run alerts on it again. Report amounts that are not integer strings throw `TollwayError` with code `invalid-amount`.

Pull request: #331.
