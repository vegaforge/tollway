---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": patch
---

Add offer sanity checks to `@vegaforge/tollway-client`.

`createClient` gains an `offerChecks` option with per-asset price ceilings
(`maxAmount`, fail-closed), payee and asset allowlists, a network mismatch
check (always on), and structural validation of the offer fields. Checks run
before the policy engine and before the settler; a failure throws
`OfferRejectedError` (code `"offer-rejected"`) and emits a `skip` event.

`createX402Settler` gains a matching `offerChecks` option that registers an
x402Client `PaymentPolicy` to filter disallowed options from multi-option
challenges.

`@vegaforge/tollway-core` adds `"offer-rejected"` to `TollwayErrorCode`.
