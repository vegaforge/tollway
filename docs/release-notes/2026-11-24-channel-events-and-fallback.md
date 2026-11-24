---
date: 2026-11-24
feature: Channel lifecycle events, and an x402 fallback when a channel cannot open
scope: feat
packages: ["@vegaforge/tollway-channels", "@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Channel lifecycle events and x402 fallback

Opening a payment channel locks an agent's funds and closing it releases
them. Both now leave a trace. The channel manager reports
`channel:opened`, `channel:closing`, `channel:closed` and
`channel:close-failed` to an `onEvent` handler, each after its store write
succeeds. `toObservabilitySink(hub)` turns the opened and closed events into
the `channel.opened` and `channel.closed` webhooks the observability hub
already listed, without delaying `open` or `close`, and `flush()` waits for
deliveries on shutdown. A handler that throws or rejects never changes a
result; its error goes to `onEventError` (#187).

`docs/design.md` promised that a failed channel open falls back to
per-request payment. With `fallback` configured, the client now does that
for one error only, `channel-open-failed`, which means nothing was offered to
the service. It asks the policy again for x402, pays once, records the spend
once for x402, and emits a `fallback` event. The counterparty's channel path
then rests: payments go straight to x402 until a cooldown ends (doubling on
each failure, capped), and one request at a time tries the channel again. An
open that may have landed is reported to `onOrphanedChannel`. A failure after
a voucher was sent is never paid again on x402 (#183).

Settlers can put `channel:opened` and `channel:closed` on the client's event
stream through `ClientSettler.subscribe`.

Not in this change: the mpp-channel settler itself (#184) needs the gate's
voucher endpoint and registration header (#173), and traffic-based demotion
(#182) needs the promotion threshold from #105. Both stay open.

Pull request: #336.
