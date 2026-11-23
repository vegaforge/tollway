---
"@vegaforge/tollway-channels": minor
---

`CommitmentStore` gains `listChannels({ status?, counterparty?, asset?, cursor?, limit? })`, implemented by the memory store and exposed through `ChannelManager.listChannels`. It returns a `ChannelPage` ordered by `openedAt` and then id, both descending, with an opaque `nextCursor` that resumes exactly after the last channel returned even when a channel's status changed in between. `limit` defaults to 50 and is capped at 200. Both additions are additive; existing stores keep compiling only if they implement the new method.
