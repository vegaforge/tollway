---
date: 2026-11-20
feature: Dynamic paywall pricing and smart-account policy planning
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-server"]
scenario-impact: none
---

# Dynamic pricing and account policy planning

Paywalls can now quote bounded per-request prices using an authenticated,
resource-bound quote. Core also exposes a pure planner and read-only checker for
mapping token-scoped budgets to OpenZeppelin Stellar spending-limit policies.
