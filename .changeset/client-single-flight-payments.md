---
"@vegaforge/tollway-client": minor
---

Share one settlement across concurrent identical payments. `pay()` calls that overlap for the same resource, routed model and offer (amount, asset, payTo, network) now settle once and resolve with the same receipt; before, each call paid. `PayRequest` gains an optional `idempotencyKey` that replaces the derived key, `PayResult` gains `deduplicated`, and a call that waited emits the new `payment:deduplicated` event instead of `payment`. Only the call that paid evaluates the policy and records the spend. Deduplication is in process and per client instance; receipts are not cached.
