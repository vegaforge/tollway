---
"@vegaforge/tollway-channels": minor
---

Move to `@stellar/stellar-sdk` 16.4.1, the one SDK version the workspace now resolves. `@stellar/mpp` stays at 0.7.1, whose `^15.1.0` SDK peer range is allowed to resolve to 16 by a scoped pnpm rule until an `@stellar/mpp` release accepts 16.
