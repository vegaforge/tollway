---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": patch
---

Add human approval for payments above a threshold (#199). Payments at or above per-asset thresholds or matching a predicate wait for an injected approver callback with a timeout. The approver receives an AbortSignal that fires on timeout. Timeout throws ApprovalTimeoutError; denial or approver throw produces ApprovalDeniedError. New client events: approval:requested and approval:resolved with outcome and latency.
