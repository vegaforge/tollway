---
"@vegaforge/tollway-channels": minor
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": minor
---

Channel lifecycle events and an x402 fallback for failed channel opens.

`createChannelManager` accepts `onEvent` and `onEventError` and emits
`channel:opened`, `channel:closing`, `channel:closed` and
`channel:close-failed` after each store write. `toObservabilitySink(hub)` maps
the opened and closed events to the `channel.opened` and `channel.closed`
webhooks, with `flush()` for shutdown (#187).

`@vegaforge/tollway-core` adds `ChannelOpenFailedError` (code
`channel-open-failed`). `createClient` accepts `fallback`: on that error, and
only that error, it re-checks the policy and pays once by x402, then rests the
counterparty's channel path with a capped exponential cooldown (#183). A new
`fallback` client event reports it, and `ClientSettler.subscribe` lets a
settler put channel events on the client stream.

`ClientSettler` gains an optional `subscribe` method. Settler
implementations without it are unaffected.
