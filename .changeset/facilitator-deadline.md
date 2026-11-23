---
"@vegaforge/tollway-server": minor
---

Bound every facilitator call with `PaywallDeps.facilitatorTimeoutMs` (default 15 s). A `/verify` that misses it is rejected with 503 `facilitator-timeout`. A `/settle` that misses it is rejected with 503 `settlement-unknown`, keeps its settlement lock until the lock TTL, and writes a late receipt to the settlement cache when the abandoned call eventually succeeds, so a retry replays it instead of settling twice. `createHttpFacilitator` accepts `timeoutMs` for the transport deadline. Adds a test-only fault-injection harness and `docs/failure-modes.md`.
