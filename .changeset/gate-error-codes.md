---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": minor
"@vegaforge/tollway-adapter-fastify": minor
"@vegaforge/tollway-adapter-hono": minor
"@vegaforge/tollway-adapter-next": minor
---

Machine-readable gate error codes and Retry-After in every adapter (#161). Every rejection carries a `code` from the exported `GateErrorCode` union (`payment-malformed`, `payment-invalid`, `offer-mismatch`, `settlement-in-progress`, `settlement-failed`, `facilitator-unavailable`, `settlement-unknown`, `facilitator-invalid-response`, `price-unavailable`, `handler-not-configured`, `model-not-supported`, and the `service-policy:*` denials). `GATE_ERRORS` exports each code's status, retry guidance and headers, and `renderGateRejection` is the one renderer all four adapters (and the Next proxy, which used to drop `Retry-After`) use. A refused payment is a 402 with a fresh `PAYMENT-REQUIRED`; the facilitator's own reason travels only in `upstreamReason`. `PaywallDeps.retryAfterSeconds` sets `Retry-After` for `settlement-in-progress` and `facilitator-unavailable` (default 1 second).

Breaking: the rejection body changes from `{ "error": "<reason>" }` to `{ "error": { "code", "message", "upstreamReason"? } }`, and `GateOutcome`'s rejected variant gains a required `code`. Facilitator transport failures are no longer thrown out of the gate: `createHttpFacilitator`, `createFailoverFacilitator` and the MPP charge handler now throw `TollwayError("facilitator-unavailable")` instead of `"payment-failed"`, and the gate answers it with a 503 (`facilitator-unavailable`, or a held `settlement-unknown` when `/settle` may have landed). Callers that branched on `payment-failed` for transport failures must branch on `facilitator-unavailable`.
