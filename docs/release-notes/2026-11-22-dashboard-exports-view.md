---
date: 2026-11-22
feature: Dashboard exports view for JSON and CSV metric downloads
scope: feat
packages: ["@vegaforge/tollway-observability"]
scenario-impact: none
---

# Dashboard exports view

Dashboard users can now export payment metrics as JSON or RFC 4180 CSV from the Exports panel on `/exports`. Users pick an inclusive UTC `From` and `To` date range and a format (`JSON` or `CSV`), inspect the matching metric count and output filename (`tollway-metrics-<from>-<to>.<ext>`), and download the generated Blob directly. Invalid date ranges (`from` after `to`, empty dates, or invalid calendar dates) disable the download button with an inline alert.

`fetchMetricsExport` and `useMetricsExport` in `apps/dashboard/src/data/` hold the data-layer seam, supplying a typed `ObservabilityHub`-shaped source seeded with deterministic stub metrics until a live observability API is wired. Spreadsheet formula-injection neutralization was added to `csvEscape` in `@vegaforge/tollway-observability` (`packages/observability/src/index.ts`), prefixing any CSV cell that starts with `=`, `+`, `-`, or `@` with a single quote so `ExportsView` outputs `hub.export(format, query)` verbatim without re-implementing CSV serialization.
