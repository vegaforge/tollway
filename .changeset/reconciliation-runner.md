---
"@vegaforge/tollway-reconcile": minor
---

Add scheduled reconciliation runner with cursor-based pagination, result persistence, and retry logic. The runner continuously walks channels and receipts from sources, reconciles each item, persists results, retries transient failures with exponential backoff, and resumes after restarts without skipping work. Exports `createReconciliationRunner`, source interfaces, store interfaces, and memory implementations.
