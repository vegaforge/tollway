---
"@vegaforge/tollway-server": minor
---

Validate facilitator capabilities at startup (#155). `FacilitatorClient.supported()` now returns the full `/supported` capability set mapped from the upstream `SupportedResponse` (`kinds`, `extensions`, `signers`), schema-checked at the boundary, rather than the lossy `{ models, assets }` shape. New exports `createFacilitatorValidator`, `validatePaywall`, `assertPaywallValid`, `parseFacilitatorCapabilities`, `FacilitatorCapabilities`, `PaywallMismatch`, `ValidationMode`, and `ValidationResult` let a service check every paywall's network / scheme / `x402Version` / `extra.areFeesSponsored` / asset / `payTo` against the advertised set in `fail` / `warn` / `off` modes, with a TTL cache. The removal of `SupportedResult` and the shape change on `FacilitatorClient.supported()` are the breaking bits; `supported()` was only called by internal tests before this change.
