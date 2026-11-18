---
"@vegaforge/tollway-server": minor
---

A settled payment is now bound to the HTTP method it paid for. The settlement cache stores `{ receipt, method }` (`SettlementEntry`), and a cached or in-flight receipt is replayed only for the same method; another method on the same URL gets `409 payment already settled for a different offer` and never a second settlement. Breaking: `SettlementCache.get` and `set` take and return a `SettlementEntry`. A Redis entry written by an older version (a bare receipt) is refused rather than treated as a miss.
