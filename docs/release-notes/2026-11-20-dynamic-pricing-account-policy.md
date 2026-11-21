---
date: 2026-11-20
feature: Dynamic paywall pricing and smart-account policy planning
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-server"]
scenario-impact: none
---

# Dynamic pricing and account policy planning

Paywalls can now quote bounded per-request prices using an authenticated,
resource-bound quote. The quote travels in the x402 challenge's
`accepts[0].extra.tollwayQuote`, so a stock x402 V2 client returns it without
changes; MPP clients echo the `TOLLWAY-QUOTE` header. Core also exposes a pure
planner and read-only checker for
mapping token-scoped budgets to OpenZeppelin Stellar spending-limit policies.
