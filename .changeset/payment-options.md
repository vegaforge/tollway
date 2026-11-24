---
"@vegaforge/tollway-server": minor
---

Several payment options in one challenge (#158). `PaywallConfig` accepts `accepts: PaymentOption[]` (amount, asset, payTo, network, and an optional per-option `facilitator`), listed in the 402 in order. A paid request is matched by exact comparison of its `accepted` (scheme, network, asset, payTo, amount, maxTimeoutSeconds) against the configured options; no match is a 402 with a fresh challenge. Verify, settle, pre-validation, the router, service policy, cache binding and the receipt all use the matched option, and a payment settled for one option is a 409 on any other. An option without a facilitator, an empty list, a non-integer amount or two identical options fail at `createPaywall`. `paymentTargets(config)` gives the capability check one target per option, and `routes.list()` entries gain `accepts`. Single-option configs produce byte-identical challenges.

Breaking: `PaywallConfig` is now a union of the single-option fields and the `accepts` form, so `Pick<PaywallConfig, ...>` and `Omit<PaywallConfig, ...>` over the single-option fields need `SinglePaymentOptionConfig` instead. `PaywallTarget` is an explicit option type, and `PaywallDeps.facilitator` is optional when every x402 option names its own. Every paid request, single-option included, is now refused before `/verify` when its `accepted` does not match the route's terms.
