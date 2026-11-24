---
"@vegaforge/tollway-channels": minor
---

`CommitmentStore` gains `listChannels({ status?, counterparty?, asset?, cursor?, limit? })`, implemented by the memory store and exposed through `ChannelManager.listChannels`. It returns a `ChannelPage` ordered by `openedAt` and then id, both descending, with an opaque `nextCursor` that resumes exactly after the last channel returned, even when a channel's status changed in between. `limit` defaults to 50 and is capped at 200.

Breaking for third-party stores: `listChannels` is a required method of `CommitmentStore`, so a store implemented outside this package stops compiling until it adds one. The memory store already has it.
