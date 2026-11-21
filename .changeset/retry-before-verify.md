---
"@vegaforge/tollway-server": patch
---

A retried x402 payment gets its receipt instead of a 402. The gate looks the payment up in its settlement cache before verifying it, using the new optional `FacilitatorClient.idempotencyKey`, because a settled payment's on-chain nonce is spent and a second verify fails. Both built-in facilitators implement it (#284).
