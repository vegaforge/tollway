---
date: 2026-11-20
feature: Adaptive anomaly detection over committed spend baselines
scope: feat
packages: ["@vegaforge/tollway-core"]
scenario-impact: none
---

# Adaptive anomaly detection

The core policy engine now supports an optional EWMA anomaly detector scoped by
asset or asset and payee. It learns only from settled spend, has a configurable
warm-up, sensitivity, and baseline growth cap, and reports a distinct
`anomaly-adaptive` decision when a projected minute exceeds its learned threshold.
