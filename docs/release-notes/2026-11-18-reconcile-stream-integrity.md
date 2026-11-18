---
date: 2026-11-18
feature: channel reconciliation checks every commitment, not just the last
scope: fix
packages: ["@tollway/reconcile"]
scenario-impact: none
---

# Reconciliation checks the whole stream

`reconcileChannel` used to compare only the last commitment in a stream with
what settled on chain. A stream whose cumulative amount went down, one that
contained a commitment from another channel, or one with a duplicated sequence
could reconcile as healthy. It now reports each of those by name:
`non-monotonic-cumulative`, `foreign-commitment` and `duplicate-sequence`.
Commitments from another channel are left out of the amount checks, and the
expected settlement is the highest amount ever committed.

Healthy streams reconcile exactly as before, and existing drift kinds and
their messages are unchanged, so current `suppress` hooks keep working.

Decision: ADR-2026-11-18-reconcile-stream-integrity.
