---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": minor
---

Add offer sanity checks to the client (#209).

`createClient` takes `offerChecks`: a price ceiling per asset (`maxAmount`,
fail closed), payee and asset allowlists, a zero-amount opt-in, and
`requireNetwork`. Structural checks on the offer always run. The checks run in
`pay()` before the policy engine and the settler; a failure throws
`OfferRejectedError` (code `offer-rejected`) and emits `skip`. `offerChecks`
is validated when the client is created.

`createX402Settler` takes the same `offerChecks` and registers the allowlists
as an x402 `PaymentPolicy` over every option in the challenge.

`@vegaforge/tollway-core` adds `offer-rejected` to `TollwayErrorCode`.
