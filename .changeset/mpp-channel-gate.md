---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-core": minor
---

The gate accepts mpp-channel vouchers through `createMppChannelHandler`, with on-chain channel registration via the `TOLLWAY-CHANNEL` header, exact-increment checks, server-assigned sequences and idempotent replays. `createChannelSettler` closes received channels on chain from the latest voucher, on configurable triggers, with a close rate guard and `resolve()` for failed closes. Adds `createInMemoryChannelStore`, `createInMemoryCloseRateGuard`, `channelRecordSchema` and `TOLLWAY_CHANNEL_HEADER`. The gate no longer answers 501 for `mpp-channel`. In core, `MppChannelPayment` replaces `sequence` and the placeholder `commitment` with `signature`, `action` and `credential`. Adds the gate error codes `channel-refused` (402) and `channel-rate-limited` (429); other channel refusals use `payment-invalid`, `settlement-in-progress` and `facilitator-unavailable`, with the channel reason in the message or `upstreamReason`.
