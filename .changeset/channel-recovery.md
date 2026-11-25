---
"@vegaforge/tollway-channels": minor
---

Add `ChannelManager.recover` for funder-side channel recovery (#38).

- Works on `open`, `closing` and `recovering` channels. Reads chain state first, moves the channel to `recovering` by compare-and-set before it starts a funder close, records the effective ledger, refunds once the current ledger is past it, and records an already-settled channel as `closed` without refunding.
- A funder close found on chain is recorded as `recovering` even when this process did not start it. `CloseNotSubmittedError` from `startClose` hands the channel back to the status it had.
- Adds `RecoveryNotYetEffectiveError`, and the `channel:recovering` and `channel:recovered` lifecycle events (`ChannelRecoveringEvent`, `ChannelRecoveredEvent`) through the existing `onEvent` and `onEventError`. `resume` now records the effective ledger when it hands a channel to recovery.
- The PostgreSQL and Redis commitment stores persist `closeEffectiveAtLedger`, `recoveredAmount` and `refundTxHash`. PostgreSQL deployments apply `migrations/0002_channel_recovery.sql` after 0001.
- Breaking for custom implementations: `MppChannelAdapter` now requires `startClose`, `refund` and `getState`. The Stellar adapter implements `getState` from `@stellar/mpp@0.7.1`; the funder transactions are issue #101, and until then `startClose` throws `CloseNotSubmittedError` wrapping a not-implemented error and `refund` throws a not-implemented error.
