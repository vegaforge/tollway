---
date: 2026-11-23
feature: Validate facilitator capabilities at startup
scope: feat
packages: [@vegaforge/tollway-core, @vegaforge/tollway-server]
scenario-impact: none
---

# Facilitator capability validation

A service can now ask its facilitator what it supports before serving, and
refuse to start when a paywall does not match, instead of the first paying
agent discovering the problem.

```ts
const validator = createFacilitatorValidator(facilitator); // mode "fail"
await validator.check({ "GET /quotes": quotesPaywall });
```

`check` reads `/supported` and compares every route's paywall with it: x402
version 2, the `exact` scheme on the paywall's network or `stellar:*`, the
paywall's own `extra.areFeesSponsored` against the facilitator's, a contract
address as `asset` and a valid `payTo`.

- `fail`, the default, throws a `FacilitatorCheckError`. Its `code` is
  `facilitator-unsupported` with every mismatch named (route, field,
  expected, advertised), or `facilitator-unavailable` when `/supported`
  cannot be read.
- `warn` passes the report to `onWarn` and resolves. An unavailable
  facilitator is reported as `unavailable`, never as valid.
- `off` skips the check.

`/supported` is cached for one minute by default (`ttlMs`), and `refresh()`
drops the cache. The demo's live mode runs the check before it serves and
prints the result. x402 `/supported` does not advertise assets, so asset
acceptance is still only confirmed by the first `/verify`; the deployment
guide says so. The check covers x402 only, since MPP charge has no
facilitator.

Breaking change: `FacilitatorClient.supported()` now returns
`FacilitatorCapabilities` (`kinds`, `extensions`, `signers`), parsed with a
schema at the boundary, and `SupportedResult` is removed. Every external
implementation of `FacilitatorClient` must change its `supported()`, not
only callers. A malformed `/supported` body throws
`facilitator-invalid-response`. `TollwayError` gained the three
`facilitator-*` codes and an optional `cause`.

Pull request: #325. Closes #155.
