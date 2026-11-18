---
"@tollway/server": minor
---

Settlement locks in `createRedisSettlementCache` are now owned: `acquire` returns a lock with a unique token, and `renew` and `release` act only if the caller still holds it, atomically in Redis. The gate renews the lock while a settlement runs and reports `lockLost` on the outcome if it was lost. Breaking: `RedisLikeClient` needs `eval` (ioredis has it) and no longer needs `del`; custom `SettlementCache` implementations must provide all of `acquire`, `renew` and `release`, or none.
