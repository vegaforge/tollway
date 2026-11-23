---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-core": minor
---

Validate facilitator capabilities at startup (#155). `createFacilitatorValidator(facilitator, { mode })` checks every route's paywall against the facilitator's `/supported` (x402 version, `exact` scheme and network, `extra.areFeesSponsored`, asset and `payTo` format) and, in the default `fail` mode, throws a `FacilitatorCheckError` (`facilitator-unsupported` or `facilitator-unavailable`). `warn` reports through `onWarn`; `off` skips. Also exported: `validatePaywall`, `parseFacilitatorCapabilities`, `describeMismatches` and their types.

Breaking: `FacilitatorClient.supported()` returns `FacilitatorCapabilities` (`kinds`, `extensions`, `signers`) instead of `{ models, assets }`, and `SupportedResult` is removed. Every implementation of `FacilitatorClient` must update `supported()`. Core: `TollwayError` gains the codes `facilitator-unsupported`, `facilitator-unavailable` and `facilitator-invalid-response`, and an optional `cause`.
