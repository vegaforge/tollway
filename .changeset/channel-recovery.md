---
"@vegaforge/tollway-channels": minor
---

Add `ChannelManager.recover` for funder-side channel recovery (#38).

- Reads chain state first, starts a close when none is in progress, refunds once the close is effective by ledger number, and records an already-settled channel without refunding.
- Adds `RecoveryNotYetEffectiveError` and `onEvent` with `channel:recovering` / `channel:recovered`; concurrent recoveries for one channel share one run.
- Breaking for custom implementations: `MppChannelAdapter` now requires `startClose`, `refund` and `getState`. The Stellar adapter implements `getState` from `@stellar/mpp@0.7.1`; the real funder transactions are issue #101 and currently throw a typed not-implemented error.
