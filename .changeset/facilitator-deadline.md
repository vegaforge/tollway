---
"@vegaforge/tollway-server": minor
---

Bound every facilitator call with `PaywallDeps.facilitatorTimeoutMs` (default 15 s); a `/verify` that misses it is rejected with 503 `facilitator-timeout`. A `/settle` whose outcome is unknown (it missed the deadline, or failed after the request may have been sent) is now held for up to `PaywallDeps.ambiguousSettlementHoldMs` (default 120 s): the gate keeps the in-flight slot and keeps renewing the settlement lock, so no retry calls `/settle` for that payment again, and a late success is cached so a retry replays it. A refused connection or DNS failure frees the payment at once. `createHttpFacilitator` accepts `timeoutMs` for the transport deadline.

Behaviour change: a `/settle` that throws a transport error other than a refused connection or DNS failure no longer releases the settlement lock straight away. Retries of that payment get 409 `settlement in progress` (other processes) or the same error (this process) until the hold ends.
