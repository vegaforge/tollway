---
"@vegaforge/tollway-server": minor
---

Serve replays after cache expiry from a receipt archive (#162). `PaymentReceiptArchive` (`findByPaymentKey`, `put`) with `createInMemoryPaymentReceiptArchive` and `createRedisPaymentReceiptArchive` (no TTL unless `retentionMs` is set; reads are schema-validated). With `PaywallDeps.receiptArchive`, the gate looks a payment up in the cache and then the archive before `/verify`, and returns the original receipt with `replayed: true` without calling the facilitator. Every fresh or late settlement is written to it with the cache's semantics (`cacheError`, `onCacheError`); a failed read goes to `onArchiveError` and falls back to `/verify`. `MppChargeHandler` gains an optional `idempotencyKey`, implemented by both built-in handlers.
