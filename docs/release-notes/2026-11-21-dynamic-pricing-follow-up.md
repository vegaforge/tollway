---
date: 2026-11-21
feature: Dynamic prices fail closed, retries after quote expiry replay, and quote secrets rotate
scope: fix
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# Dynamic pricing: safer failures, retries and rotation

Three fixes to dynamic-price routes (#293, following #157):

- A price function that throws, or returns a value that is not a
  non-negative integer string within `minAmount` and `maxAmount`, now gets a
  `rejected` outcome with status 500 and a reason starting `invalid-amount:`.
  It used to throw out of the gate, so each framework adapter answered in its
  own way. Nothing is charged either way. The thrown error goes to the new
  `PaywallDeps.onPriceError` hook and is never shown to the agent.
- A client that retries a settled payment after its quote expired gets its
  receipt back, as on a fixed-price route. It used to get a 402, and a stock
  x402 client would pay again. An expired quote still never pays for a new
  payment.
- `PaywallConfig.previousQuoteSecrets` lets the quote secret rotate without
  failing quotes already handed out. The rotation steps are in
  `apps/web/src/content/docs/dynamic-pricing.mdx`.

New tests drive a dynamic route through all four adapters and through a
stock `x402Client` from `@x402/core`, whose own `createPaymentPayload` echoes
the quote in `accepted.extra`.
