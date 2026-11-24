---
date: 2026-11-24
feature: Channel detail page with the commitment stream, drawdown and reconcile status
scope: feat
packages: ["@vegaforge/tollway-dashboard"]
scenario-impact: none
---

# Channel detail page

`/channels/[channelId]` shows one channel: its header, its deposit, committed amount, remaining budget and drawdown, a chart of cumulative commitments against the deposit and the close threshold, the commitment stream with each step's change, the latest reconciliation result, and the receipts that settle through it.

The chart is an inline SVG with a text summary and the stream table as its accessible alternative. A sequence gap or a falling total is flagged in the table. The reconciliation panel says "not reconciled yet" for a channel that was never checked, so it never reads as ok. An unknown id shows a not-found state.

The channels table links each id to this page, and the receipts view links a channel settlement here. The receipts view also takes `?payee=` to show only the receipts paid to one counterparty.
