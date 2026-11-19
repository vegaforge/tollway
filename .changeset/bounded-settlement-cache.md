---
"@vegaforge/tollway-server": minor
---

`createInMemorySettlementCache(ttlMs, options?)` accepts `maxEntries` (default 10000; the oldest entry is evicted when full) and an injectable `now` clock, and sweeps expired entries on every `set` with no background timer. Callers that pass only `ttlMs` behave the same apart from eviction.
