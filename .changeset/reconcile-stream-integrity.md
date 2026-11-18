---
"@tollway/reconcile": minor
---

`reconcileChannel` now checks the whole commitment stream. New drift kinds: `non-monotonic-cumulative` (a cumulative amount went down), `foreign-commitment` (a commitment names another channel; it is excluded from the amount checks) and `duplicate-sequence` (one sequence appears more than once; the highest amount counts). The expected settlement is the highest amount ever committed rather than the last entry. Breaking for exhaustive `switch` statements over `DriftKind`.
