---
"@vegaforge/tollway-server": minor
---

Use the x402 `payment-identifier` extension as an idempotency key. Every 402 now declares the extension (`PaywallConfig.paymentIdentifier.required`, default `false`). A payment that carries an id is also keyed on that id scoped to the verified payer, so a client that re-signs the same payment as a new envelope gets its first receipt back instead of settling twice. An invalid id, or a missing one on a route that requires it, is rejected with 400. `SettlementCache` gains an optional `setMany`, which the Redis cache implements as one atomic script so the digest and id keys are written together.
