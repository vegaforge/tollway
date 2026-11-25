---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-channels": minor
---

Size channel deposits from policy headroom, and stop blocking channel payments on the minimum deposit.

- Fix: `minChannelDeposit` applies only to channel opens. A per-request channel payment is no longer compared with it, so it no longer blocks payments priced below the minimum.
- `PolicyEngine.headroom(asset, payee)` and `PolicyEngine.evaluateChannelOpen(...)` are new and optional on the interface. The open check does not record spend.
- `sizeDeposit` in `@vegaforge/tollway-channels` is new. It is pure, uses integer arithmetic, and returns `open: false` with a reason when no deposit should be opened.
