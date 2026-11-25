---
"@vegaforge/tollway-channels": minor
---

Adds `createChannelPool`: several channels per counterparty and asset, leased one payment at a time, with selection by least drawn or round robin, limits on channel count and locked deposit, single-flight opens, background rotation before a channel runs dry, lease timeouts, and a typed `ChannelPoolExhaustedError`.
