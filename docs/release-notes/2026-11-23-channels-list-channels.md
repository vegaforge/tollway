---
date: 2026-11-23
feature: List tracked channels from the channel manager
scope: feat
packages: [@vegaforge/tollway-channels]
scenario-impact: none
---

# List tracked channels from the channel manager

`ChannelManager` could open, commit, read and close a channel but had no way to
enumerate the channels a deployment tracks. `CommitmentStore` now has
`listChannels({ status?, counterparty?, asset?, cursor?, limit? })` and the
manager forwards it, returning a `ChannelPage`.

Pages are ordered by `openedAt` and then channel id, both descending, so the
newest channel comes first and the order is stable. `limit` defaults to 50 and
is capped at 200; anything else is a `RangeError`. `nextCursor` is opaque and
resumes exactly after the last channel the previous page returned, so a channel
whose status changes between two requests is not skipped or repeated.
`nextCursor` is absent on the last page.

This is the store foundation for the service channel endpoints in #227, which
remain blocked on the `@vegaforge/tollway-service` scaffold in #224.
