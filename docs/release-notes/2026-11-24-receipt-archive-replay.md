---
date: 2026-11-24
feature: Replays after cache expiry are served from a receipt archive
scope: feat
packages: ["@vegaforge/tollway-server"]
scenario-impact: updated
---

# Replays from the receipt archive

A payer that retries a payment which already settled, after its entry has left the 30-second settlement cache, now gets its original receipt instead of a 402 (or, with the mock facilitator, a second settlement). Configure `receiptArchive` with `createRedisPaymentReceiptArchive` or `createInMemoryPaymentReceiptArchive`; the gate looks the payment up before `/verify` and never calls the facilitator for it again. The same offer and method binding as the cache applies, so the archive extends how long a payment can be replayed, not what it unlocks. MPP charge payments replay too.

See docs/receipt-archive.md for what holding a settled payment grants and how to choose a retention. Related issue: #162. Scenario: docs/scenarios/gate-errors-and-replays.md (updated). Pull request: #342.
