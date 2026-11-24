---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-core": minor
---

Publish paywalled routes through x402 Bazaar discovery, opt-in per route (#154).

- `PaywallConfig.discovery` adds `extensions.bazaar` to the 402, enriched
  with the request method and route template, without the payer's own path
  values. Routes without it publish nothing.
- `listDiscoveryResources` reads a facilitator's catalogue, validated at the
  boundary.
- New dependency `@x402/extensions` `~2.31.0` in the server, and new error
  code `invalid-discovery` in core.
