---
date: 2026-11-24
feature: Wire the dashboard Overview to typed spend, outcome, channel and receipt data
scope: feat
packages: ["@vegaforge/tollway-dashboard"]
scenario-impact: none
---

# Wire the dashboard Overview

The Overview replaces its placeholders with data. It shows settled spend per asset, the number of payments settled, the failure rate, open channels with their remaining budget per asset, the model mix, the five newest receipts, and the three newest anomalies.

Spend is computed by `@vegaforge/tollway-observability`. Only settled payments count toward an amount, and each asset is kept apart, so a failed payment never adds to spend and USDC is never summed with XLM. The failure rate is failed over attempted (settled plus failed). With nothing attempted it reads "No payments" instead of 0%.

The shared amount formatter (`formatAmount` in `src/lib/amount.ts`) replaces the three copies in the agents, channels and receipts views. It keeps every digit of the amount instead of truncating to two places. The agents and channels headline totals now name each asset, and the channels totals no longer add amounts across assets.
