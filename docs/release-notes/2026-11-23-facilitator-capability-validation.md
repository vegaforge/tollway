---
date: 2026-11-23
feature: Validate facilitator capabilities at startup
scope: feat
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# Facilitator capability validation

`FacilitatorClient.supported()` now returns the full `/supported` capability
set from `@x402/core` (`kinds`, `extensions`, `signers`), schema-checked at
the boundary, instead of the lossy `{ models, assets }` shape it returned
before. Callers can feed it into the new `createFacilitatorValidator(...)`
or the lower-level `validatePaywall(...)` to check that every paywall's
network, scheme, `x402Version`, `extra.areFeesSponsored` and address shape
match what the facilitator advertises before the first paying agent hits
the gate.

Three operator modes are supported:
- `fail` (default): `assertPaywallValid` throws `TollwayError("payment-failed", ...)`
  with every mismatch named (route, field, expected, advertised) so a boot
  script aborts.
- `warn`: mismatches are reported through an `onWarn` callback while the
  gate keeps serving.
- `off`: the historic no-check behaviour.

A one-minute TTL cache (configurable) in `createFacilitatorValidator`
revalidates `/supported` after that window so a facilitator deploy that
drops a network is noticed without a server restart. A facilitator that is
unreachable in `warn` mode surfaces a synthetic mismatch rather than being
treated as "supports everything".

The old `SupportedResult` type and its `{ models, assets }` shape are
removed. This is a breaking change on an exported interface, which the
changeset covers as a minor bump — `supported()` was only called by
internal tests before this issue.

Closes #155.
