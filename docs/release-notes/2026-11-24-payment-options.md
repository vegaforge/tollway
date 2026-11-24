---
date: 2026-11-24
feature: Several assets or networks in one 402, settled with the payer's choice
scope: feat
packages: ["@vegaforge/tollway-server"]
scenario-impact: updated
---

# Payment options

A route can now accept more than one way to pay, for example USDC on mainnet and on testnet, each with its own facilitator. List them in `accepts`; the 402 offers all of them in order, and the payer settles with the one it picks. The gate never takes the payer's word for the terms: its `accepted` must match one configured option exactly, and everything after that, verification, settlement, policy and the receipt, uses the matched option. A payment for one option can never satisfy another.

Single-option routes are unchanged on the wire. The mock demo has a two-option route: `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start payment-options`; it runs in `all-models` too. **Breaking (types):** `PaywallConfig` is a union, so code that picks or omits its single-option fields uses `SinglePaymentOptionConfig`. See docs/payment-options.md. Related issue: #158. Scenario: docs/scenarios/payment-options.md (updated). Pull request: #342.
