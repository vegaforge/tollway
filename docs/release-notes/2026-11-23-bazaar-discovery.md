---
date: 2026-11-23
feature: Publish paywalled routes to x402 Bazaar catalogues, opt-in per route
scope: feat
packages: ["@vegaforge/tollway-server", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Bazaar discovery

A paywall can now describe its route so a facilitator that keeps a Bazaar
catalogue can list it. Nothing is published unless the paywall has a
`discovery` block; routes without one are unchanged.

- `PaywallConfig.discovery` takes the input kind (`query`, or `body` with a
  `bodyType`), example input and output, their schemas, a `:param` route
  template, a description and a MIME type. The 402 challenge then carries
  `extensions.bazaar`, built by `declareDiscoveryExtension` and enriched with
  the request method and route template by `bazaarResourceServerExtension`
  from `@x402/extensions`, and `resource.description` and `resource.mimeType`.
- The x402 client echoes the extension into the payment, and
  `createHttpFacilitator` forwards that payment unchanged, so a facilitator
  reads it with `extractDiscoveryInfo`. A test runs the real client and the
  real `extractDiscoveryInfo` over the payload Tollway sends to `/verify`.
- The catalogue lists the route template. The upstream enrichment would also
  copy the payer's own path values into the declaration; Tollway publishes
  the declared `pathParams` example instead, or none.
- `createPaywall` refuses an invalid declaration with the new code
  `invalid-discovery`: a bad route template, or one that fails
  `validateDiscoveryExtensionSpec` or `validateDiscoveryExtension`.
- `listDiscoveryResources` reads a facilitator's catalogue through
  `withBazaar` and checks the response with a schema, throwing
  `facilitator-invalid-response` with the field path when it is malformed.

`@x402/extensions` is pinned to `~2.31.0`, so the server resolves one
`@x402/core`. design.md open question 3 now records the format and why the
router does not use catalogue data yet. The new docs page is
`apps/web/src/content/docs/discovery.mdx`.

Pull request: #329. Closes #154.
