---
date: 2026-11-18
feature: Redis settlement locks are owned, renewed and released only by their holder
scope: fix
packages: ["@vegaforge/tollway-server"]
scenario-impact: none
---

# Settlement locks belong to whoever took them

When several gate processes share Redis, the lock that stops two of them
settling the same payment is now owned. Each acquisition stores a unique
token, and renewing or releasing the lock checks that token in one atomic
Redis script, so a process whose lock expired can no longer remove the lock
another process holds. While a settlement runs, the gate renews its lock every
third of the lock TTL. If the lock is lost anyway, the settled outcome carries
`lockLost: true` and `onCacheError` is called, so an operator can see that
duplicate protection was not held throughout.

`PaywallDeps.settlementLockTtlMs` sets the lock TTL (default 30 000 ms).
`RedisLikeClient` now needs `eval`, which ioredis provides. A cache that
implements only some of `acquire`, `renew` and `release` is rejected when the
gate is created.

Decision: ADR-2026-11-18-redis-lock-ownership.
