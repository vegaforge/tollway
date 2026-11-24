---
date: 2026-11-23
feature: Concurrent identical client payments share one settlement
scope: fix
packages: ["@vegaforge/tollway-client"]
scenario-impact: none
---

# Concurrent identical payments are paid once

An agent that called `client.pay()` twice in parallel for the same resource
and offer paid twice. Each call signed its own authorization, so the gate
rightly saw two payments. Tool-calling models and retry loops in user code do
this often.

`pay()` is now single-flight per purchase. While one settlement is in flight,
a call for the same purchase waits for it and resolves with the same receipt.
Two calls are the same purchase when their `resource`, their settlement model
after routing, and the offer's `amount`, `asset`, `payTo` and `network` are
equal. The new optional `PayRequest.idempotencyKey` replaces that derived key:
calls with the same key share a settlement whatever their offers, and calls
with different keys never do.

Only the call that pays evaluates the policy, records the spend and emits
`payment`. A call that waited emits the new `payment:deduplicated` event, and
`PayResult` gains `deduplicated` (`false` for the call that paid, `true` for a
call that waited). When the shared settlement fails, every call rejects with
the same error object, no spend is recorded, and one `error` event is emitted.

The in-flight entry is removed when the settlement finishes, and receipts are
not cached: a later call is a new purchase and pays again. Deduplication is
per `createClient()` instance and in process only, so an agent running several
workers can still pay once per worker. The root README, "Concurrent payments",
documents all of this. Closes #210.
