---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-client": minor
---

Add policy decision traces (`PolicyEngine.evaluate`, `policyTraceSchema`, `decisionFromTrace`, `comparePolicyTraces`), a `mode: "dry-run"` policy mode, and in the client a `policy:decision` event, a `shadow` candidate policy with `policy:shadow` events, and a startup warning for dry-run. `PolicyEngine` implementations must now provide `mode` and `evaluate`.
