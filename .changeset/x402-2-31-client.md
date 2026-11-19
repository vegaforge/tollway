---
"@vegaforge/tollway-client": minor
---

Move to `@x402/core` and `@x402/stellar` 2.31 and `@stellar/stellar-sdk` 16.4.1. `createX402Settler` caps x402's new client spend controls at the approved offer (its asset, at most its amount) instead of x402's default of USDC only and $1 per payment, and reports signing failures as a `TollwayError` with code `payment-failed`.
