---
date: 2026-11-25
feature: Channel pool with several channels per counterparty, selection and limits
scope: feat
packages: ["@vegaforge/tollway-channels"]
scenario-impact: none
---

# Channel pool with several channels per counterparty, selection and limits

One channel handles one payment at a time, because its commits are serialised (#175). A pool leases whichever of several channels is free, so payments to one counterparty no longer queue behind each other.

## What changed

- **`createChannelPool`** with `acquire({ counterparty, asset, amount })` and `release(lease)`.
- **Selection** by `least-drawn` (the lowest committed share of its deposit, compared exactly) or `round-robin`. The same channel is never leased to two payments at once.
- **Limits** on channels per counterparty and asset (`maxChannelsPerKey`) and on total locked deposit (`maxLockedDeposit`, summed with `bigint`). At a limit, `acquire` waits up to `acquireTimeoutMs`, then rejects with `ChannelPoolExhaustedError` (code `channel-pool-exhausted`).
- **Single-flight opens.** Concurrent acquires share one replacement rather than opening several.
- **Rotation.** A channel whose remaining deposit drops below `rotateBelow` gets a replacement opened in the background. Once its remaining deposit is below the payment's amount it is no longer leased, and once a healthy replacement exists it is retired and reported.
- **Restart.** Membership is read from the store with `listChannels`, so a restart reuses open channels and keeps within its limits.
- **Failures** are reported through `onFailure`: a failed open, a channel the service reports closed, and a retired channel. A lease that is never released is reclaimed after `leaseTimeoutMs`.

## Known limits

- Leases live in one process. Two processes sharing a store can still race for one channel. The store's compare-and-set keeps the stream correct, and the loser should lease another channel and retry.
- A retired channel is not closed by the pool. The caller closes it, which is the close path of #180.
- Deposits are a fixed amount. Sizing from #181 is not wired in.

## Verification

`packages/channels/src/pool.test.ts` covers leasing, the concurrent-lease rule, single-flight opens, the exhaustion timeout, the locked-deposit limit, lease expiry, rotation, a restart, a closed channel and a failed open. Nothing has been run. The tests were written and the code was checked by reading it.
