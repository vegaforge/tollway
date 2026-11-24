---
date: 2026-11-24
feature: The gate accepts mpp-channel vouchers, and the service closes received channels on chain
scope: feat
packages: [@vegaforge/tollway-server, @vegaforge/tollway-core]
scenario-impact: none
---

# Receiving MPP channel payments

A service can now be paid through an agent's one-way Stellar channel. Before,
the gate answered 501 for `mpp-channel`. An agent names its channel in the new
`TOLLWAY-CHANNEL` header; the service checks the channel contract on chain
(payout address, token, not closing, refund window), reads the commitment key
from the contract, and answers with the MPP channel challenge. Each voucher
must add exactly the price, and its receipt is anchored at
`{ kind: "channel-commitment", channelId, sequence }`, with the funder as
payer. Resending a voucher returns its original receipt from the settlement
cache. Rejections carry a stable code (for example `channel-settling:` or
`wrong-increment:`) listed in docs/mpp-channels.md.

`createChannelSettler` closes channels with the latest accepted voucher, on
triggers the service configures (accrued amount, fraction of balance, idle
time, channel age) or on demand, and records a `SettlementRecord` for
`@vegaforge/tollway-reconcile`. It freezes the channel before reading the
voucher, so a voucher accepted during the close cannot be lost, caps closes
per fee payer, and leaves a failed close `settling` until `resolve()` has read
the chain. An agent can also send a `close` credential when the service
configures a fee payer.

Technical shape: `createMppChannelHandler` keeps one `mppx` channel method per
channel (bounded by count and idle time), a registration rate limit, and a
`ChannelStore` whose every write is a compare-and-set on a version.
`@stellar/mpp` 0.7.1 verifies each voucher's signature; Tollway marks the
voucher pending before that call and records it after, and
`handler.reconcile()` resolves a crash in between. `MppChannelPayment` in core
now carries the real credential fields. Issues #173 and #174, pull request
#346.
