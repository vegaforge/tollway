---
date: 2026-11-24
feature: Configurable router promotion, channel recovery, gate observability and adapter conformance
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-channels", "@vegaforge/tollway-server", "@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next", "@vegaforge/tollway-demo"]
scenario-impact: none
---

# Router thresholds, channel recovery, observability and adapter conformance

Four issues landed together. Each keeps the payment path's existing guarantees
and adds an opt-in or explicitly scoped behaviour.

## #105 — configurable channel promotion

`createDefaultRouter({ channelThreshold })` accepts a positive finite integer
requests-per-minute threshold. A route is promoted to the MPP channel only
when it is eligible, is above the threshold, has no quarantine, and has a
usable channel adapter. Calling `createDefaultRouter()` with no options behaves
exactly as before: no traffic is promoted automatically. Invalid thresholds
throw a `TollwayError` at construction rather than being silently clamped.
`docs/design.md` open question 5 now records that the operationally correct
threshold is still open.

## #38 — funder recovery from a quiet recipient

`ChannelManager.recover(channelId)` reads chain state first. With no close in
progress it starts the funder's close and records the effective ledger; once
that ledger is reached it refunds the remaining balance in a single call; a
channel whose recipient already settled is recorded as `closed` without a
second refund. Before the close is effective it throws
`RecoveryNotYetEffectiveError` with both ledger numbers, and concurrent
`recover` calls for one channel share a single run. `onEvent` reports
`channel:recovering` and `channel:recovered`; a throwing observer is isolated.
Ledger numbers, not wall-clock time, decide when a refund is allowed, and
amounts remain integer strings in base units.

This is **breaking for custom `MppChannelAdapter` implementations**, which now
supply `startClose`, `refund` and `getState`. The Stellar adapter maps
`getState` onto `@stellar/mpp@0.7.1`'s read-only `getChannelState`. Its funder
`close_start` and `refund` transactions are intentionally not faked here; they
are issue #101, and the adapter throws a typed not-implemented error until then.

## #106 — payment metrics and receipt events at the gate

`PaywallDeps` accepts a structural `observer` (`record` plus `emit`), so the
server has no runtime dependency on the observability package; an
`ObservabilityHub` satisfies it directly. A fresh settlement records a
`settled` metric and emits `receipt.created` with the receipt id, resource,
model and amount. A rejected verification or settlement records a `failed`
metric. Replayed cache hits are not reported again. Event delivery is started
but never awaited, and a throwing observer or rejected delivery goes to
`onObserverError` without changing the payment outcome. A failed verification
has no verified payer, so its metric carries `payer: ""` rather than an
invented address; the field stays a string for every metrics consumer.

The demo now wires a hub in mock mode, prints `hub.summarize()` after the paid
request, and its test asserts that the summary counts one settled payment.

## #107 — one conformance suite for four adapters

`@vegaforge/tollway-server/testing` exports a framework-free
`runAdapterConformance` suite and a small driver interface. Express, Fastify,
Hono and Next each run the same cases: a 402 with challenge header and body, a
paid handler with the receipt and response headers, every rejection status as
`{ error }`, repeated header values, case-insensitive header names, and a gate
that throws.

Decision for Express: a thrown gate error is now answered by the middleware as
HTTP 502 `{ error: "payment backend unavailable" }` instead of being forwarded
to `next(err)`. Fastify, Hono and Next have no equivalent error channel, and
Express's default error handler would leak the internal message. Error logging
belongs to the gate or an outer middleware. No adapter leaks the internal
message into the response.

Closes #105, #38, #106 and #107.
