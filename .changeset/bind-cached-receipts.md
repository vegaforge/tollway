---
"@tollway/server": patch
---

Bind cached receipts to their offer. The settlement cache key is now `<model>:<nonce>`, and a cached receipt is only returned when its resource, amount, asset, payee, network, and model match the offer being served; otherwise the gate answers 409. Concurrent requests with the same payment settle once. Cache writes are awaited, and a failed write is reported as `cacheError` on the settled outcome and through the new `onCacheError` option. `SettlementCache` gains optional `acquire` and `release` methods for a cross-process settlement lock, which `createRedisSettlementCache` implements with `SET NX PX`; `RedisLikeClient` now also needs that `set` overload and `del`.
