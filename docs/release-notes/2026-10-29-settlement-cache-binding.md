---
date: 2026-10-29
feature: Bind cached receipts to their offer, settle concurrent duplicates once, await cache writes
scope: fix
packages: [@tollway/server]
scenario-impact: none
---

# Bind cached receipts to their offer

A payment now unlocks only the offer it paid for. When the gate finds a
payment in its settlement cache, it returns the cached receipt only if the
receipt's `resource`, `amount`, `asset`, `payee`, `network`, and `model`
match the offer being served. A payment presented against a different offer
gets `409` with `payment already settled for a different offer`, and the
facilitator is not called. A retry of the same request behaves as before:
`200` with the original receipt and `replayed: true`.

Two requests carrying the same payment at the same moment now settle once.
Inside one process the gate keeps the pending settlement in memory and the
second request waits for it. Across processes, a cache that implements the
new optional `acquire` and `release` methods provides a lock; the Redis
cache does this with `SET NX PX`. If the lock is held elsewhere the gate
answers `409` with `settlement in progress` and the client can retry. A
custom cache without these methods still works, with in-process
deduplication only.

Cache writes are awaited. If a write fails after the payment has settled,
the payer still gets the receipt, the outcome carries the error as
`cacheError`, and the optional `onCacheError(error, key)` callback in
`PaywallDeps` is called. The failure can no longer surface as an unhandled
rejection.

Upgrade notes:

- Cache keys change from `<nonce>` to `<model>:<nonce>`. Entries written by
  an older gate in a shared Redis are ignored until they expire (one TTL).
- `RedisLikeClient` now also requires `set(key, value, "PX", ttlMs, "NX")`
  and `del(key)`. `ioredis` and `ioredis-mock` provide both.
- `createRedisSettlementCache` returns `LockingSettlementCache`, a
  `SettlementCache` with `acquire` and `release` present.

Not changed: the cache lookup still runs after `verify`, the receipt format,
and the adapters' source.

Scenario impact: no manual scenario under `docs/scenarios/` covers the
settlement cache. The new behaviour is locked by tests in
`packages/server/src/gate.test.ts`, `packages/server/src/cache.test.ts`, and
`packages/adapter-express/src/adapter.test.ts`.

Decision record: `docs/adr/ADR-2026-10-29-settlement-cache-binding.md`.
