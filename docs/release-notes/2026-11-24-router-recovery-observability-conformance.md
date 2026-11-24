---
date: 2026-11-24
feature: Configurable router promotion, channel recovery, gate observability and adapter conformance
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-channels", "@vegaforge/tollway-server", "@vegaforge/tollway-observability", "@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next", "@vegaforge/tollway-demo"]
scenario-impact: none
---

# Router thresholds, channel recovery, observability and adapter conformance

Four issues landed together. Each keeps the payment path's existing guarantees
and adds an opt-in or explicitly scoped behaviour.

## #105: configurable channel promotion

`createDefaultRouter({ channelThreshold })` takes
`{ requestsPerMinute, minWindowSeconds }`. The router returns `mpp-channel`
with reason `traffic` only when the request's traffic snapshot meets both
values, the offer lists `mpp-channel` (or, with no offer, the policy does),
the policy allows it, and the counterparty is not quarantined. An explicit
override still wins. Both values must be positive integers, or construction
throws a `TollwayError`. Calling `createDefaultRouter()` with no options
behaves exactly as before: no traffic is promoted. The router does not count
traffic; the caller passes the snapshot. `docs/design.md` open question 5
still records that the right production values are open.

## #38: funder recovery from a quiet recipient

`ChannelManager.recover(channelId)` works on an `open`, `closing` or
`recovering` channel and reads chain state first:

- With no close on chain, it moves the channel to `recovering` by
  compare-and-set, submits the funder's `close_start` and records the ledger
  at which the close becomes effective.
- With a close on chain and funds left, it records the channel as
  `recovering` with that ledger even if this process did not start the close,
  so no commit can follow. Once the current ledger is past it, it refunds and
  moves the channel to `recovered` with the amount and transaction.
- Before then it throws `RecoveryNotYetEffectiveError` with both ledger
  numbers.
- With nothing left in the contract, the recipient already closed: it records
  that settlement and moves the channel to `closed` without refunding.

If the adapter reports that `close_start` was not submitted
(`CloseNotSubmittedError`), the channel goes back to the status it had. Any
other failure leaves it `recovering`, and the next call reads the chain again.
Concurrent `recover` calls in one process share one run, and the status
compare-and-set stops a concurrent `close` and `recover` from both acting.
Ledger numbers, not wall-clock time, decide when a refund is allowed, and
amounts stay integer strings in base units. `resume` now also records the
effective ledger when it hands a channel to recovery.

The manager reports `channel:recovering` (with `closeEffectiveAtLedger`) and
`channel:recovered` (with `recoveredAmount` and `refundTxHash`) through the
same `onEvent` and `onEventError` as the other lifecycle events.

The PostgreSQL and Redis commitment stores persist the three new channel
fields. PostgreSQL deployments apply
`packages/channels/migrations/0002_channel_recovery.sql` after 0001.

This is **breaking for custom `MppChannelAdapter` implementations**, which now
supply `startClose`, `refund` and `getState`. The Stellar adapter maps
`getState` onto `@stellar/mpp@0.7.1`'s read-only `getChannelState`. Its funder
`close_start` and `refund` transactions are issue #101: until then `startClose`
throws `CloseNotSubmittedError` wrapping a not-implemented error, so the
channel is handed back, and `refund` throws a not-implemented error.

## #106: payment metrics and receipt events at the gate

`PaywallDeps` accepts a structural `observer` (`record` plus `emit`), so the
server has no runtime dependency on the observability package; an
`ObservabilityHub` satisfies it directly. A fresh settlement records a
`settled` metric and emits `receipt.created` with the receipt id, resource,
model and amount. A rejected verification, or a settlement that fails or
throws, records a `failed` metric. A replay from the idempotency cache, or a
request that shares another request's settlement of the same payment, records
nothing, so one payment counts once. Event delivery is started but never
awaited, and a throwing observer or rejected delivery goes to
`onObserverError` without changing the payment outcome.

A failed verification has no verified payer, so its metric carries
`payer: ""`. The observability stores now accept an empty payer on a `failed`
metric only; every other outcome still requires one.

The demo wires a hub in mock mode, prints `hub.summarize()` after the paid
request, and its test asserts that the summary counts one settled payment.

## #107: one conformance suite for four adapters

`@vegaforge/tollway-server/testing` exports a framework-free
`runAdapterConformance` suite and a small driver interface. Express, Fastify,
Hono and Next each run the same cases: a 402 with challenge header and body, a
paid handler with the receipt and response headers, every rejection status as
`{ error }`, a payment header sent twice, case-insensitive header names, and a
gate that throws. A payment header sent twice reaches the gate as one joined
value in every framework, and all four refuse it with 400 rather than settle
either value.

Decision for Express: a thrown gate error is now answered by the middleware as
HTTP 502 `{ error: "payment backend unavailable" }` instead of being forwarded
to `next(err)`. Fastify, Hono and Next have no equivalent error channel, and
Express's default error handler would leak the internal message. No adapter
leaks the internal message into the response.

Closes #105, #38, #106 and #107.
