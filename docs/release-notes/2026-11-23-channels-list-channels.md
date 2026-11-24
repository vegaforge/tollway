---
date: 2026-11-23
feature: The service channels API, and listing tracked channels from the channel manager
scope: feat
packages: [@vegaforge/tollway-channels, @vegaforge/tollway-service]
scenario-impact: none
---

# The service channels API

Operators can now see every MPP channel a deployment tracks, and close one,
from the optional shared service (#227).

`ChannelManager` could open, commit, read and close a channel but had no way to
enumerate them. `CommitmentStore` now has `listChannels({ status?, counterparty?,
asset?, cursor?, limit? })`, and the manager forwards it. Pages are ordered
newest first, with the channel id as a tie-break. `limit` defaults to 50 and is
capped at 200. `nextCursor` is opaque and resumes exactly after the last channel
returned. Adding a required method to `CommitmentStore` is a breaking change
for stores implemented outside the package.

`@vegaforge/tollway-service` gains `createChannelsModule()`, mounted with the
deployment's own `channelManager`:
- `GET /v1/channels` lists channels with `status`, `counterparty` and `asset`
  filters. Each row adds `remaining` (deposit minus committed, as a bigint) and
  `shouldClose`.
- `GET /v1/channels/{id}` returns one channel.
- `GET /v1/channels/{id}/commitments` pages the commitment stream by sequence,
  without the signed blob unless an `admin` key passes `include=blob`.
- `POST /v1/channels/{id}/close` (admin) closes the channel. A second request
  for a channel already closing or closed returns it as it is, and a channel
  in `recovering` returns 409.

Concurrent close requests for one channel in one process share a single close,
so the adapter submits once. A test holds the chain read that sits between the
manager's status check and its write of `closing`; without the guard, five
concurrent requests submit five closes. The close records the requesting key's
name and emits `channel.closed`. Across replicas the guard needs the store's
compare-and-set from #175, which the docs say.

Pull request: #324.
