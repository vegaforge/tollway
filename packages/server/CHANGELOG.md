# @vegaforge/tollway-server

## 0.1.0

### Minor Changes

- 42fc74c: A settled payment is now bound to the HTTP method it paid for. The settlement cache stores `{ receipt, method }` (`SettlementEntry`), and a cached or in-flight receipt is replayed only for the same method; another method on the same URL gets `409 payment already settled for a different offer` and never a second settlement. Breaking: `SettlementCache.get` and `set` take and return a `SettlementEntry`. A Redis entry written by an older version (a bare receipt) is refused rather than treated as a miss.
- 42fc74c: Settlement locks in `createRedisSettlementCache` are now owned: `acquire` returns a lock with a unique token, and `renew` and `release` act only if the caller still holds it, atomically in Redis. The gate renews the lock while a settlement runs and reports `lockLost` on the outcome if it was lost. Breaking: `RedisLikeClient` needs `eval` (ioredis has it) and no longer needs `del`; custom `SettlementCache` implementations must provide all of `acquire`, `renew` and `release`, or none.

### Patch Changes

- 7090609: Bind cached receipts to their offer. The settlement cache key is now `<model>:<nonce>`, and a cached receipt is only returned when its resource, amount, asset, payee, network, and model match the offer being served; otherwise the gate answers 409. Concurrent requests with the same payment settle once. Cache writes are awaited, and a failed write is reported as `cacheError` on the settled outcome and through the new `onCacheError` option. `SettlementCache` gains optional `acquire` and `release` methods for a cross-process settlement lock, which `createRedisSettlementCache` implements with `SET NX PX`; `RedisLikeClient` now also needs that `set` overload and `del`.
- Updated dependencies [42fc74c]
  - @vegaforge/tollway-core@0.1.0
