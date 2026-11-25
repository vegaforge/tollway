---
date: 2026-11-24
feature: Opt-in two-phase settlement, settling only after the route succeeds
scope: feat
packages: [@vegaforge/tollway-server, @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-fastify, @vegaforge/tollway-adapter-hono, @vegaforge/tollway-adapter-next]
scenario-impact: none
---

# Two-phase settlement

A paid request whose route handler throws or answers 500 used to be charged
anyway, because the gate settled before the route ran. Routes can now opt in
to settling afterwards: the payment is verified and locked, the route runs
with its response held, and the payment settles only if the route did not
fail. Closes #152.

Turn it on per route with the same option in every adapter:
`expressPaywall(gate, { settlement: "after-handler" })`, likewise
`fastifyPaywall`, `honoPaywall`, `withPaywall(gate, handler, options)` and the
four route-table helpers. The default, `"before-handler"`, is unchanged.

In two-phase mode:

- A route that throws, or answers a failure status (any 5xx unless
  `twoPhase.isFailureStatus` says otherwise), never reaches `/settle`. Its
  own response goes out with no `PAYMENT-RESPONSE` and no receipt.
- A successful route's response is held until settlement finishes. If
  `/settle` refuses, the held response and its headers are discarded and the
  client gets the rejection, so the resource is never released unpaid.
- Responses are held up to `twoPhase.maxResponseBytes` (1 MiB by default),
  counted as the route writes. A larger or longer stream abandons the
  payment and the client gets 500 `response-too-large`.
- The settlement lock and the in-flight slot cover the route's whole run,
  so concurrent duplicates still reach `/settle` at most once, and the route
  runs once per settlement attempt. A duplicate waits, then replays the
  receipt, or gets 503 `payment-not-settled` with `Retry-After: 1` if the
  first attempt was abandoned.
- A route that outlives the payment's validity window (`maxTimeoutSeconds`)
  is abandoned with 504 `handler-timeout`. A lock lost while the route runs
  ends in 503 `payment-not-settled`. The lock is renewed, not
  lengthened: `settlementLockTtlMs` is unchanged.
- A replay of a settled payment runs the route as the single-shot gate does,
  and nothing settles again.

Three codes join the gate error table from #161 (docs/gate-errors.md):
`payment-not-settled` (503, the same payment may be sent again after
`Retry-After`), `handler-timeout` (504) and `response-too-large` (500). Every
adapter renders them, like every other rejection, through
`renderGateRejection`.

The shared adapter conformance suite from #344 gains a two-phase section,
which every adapter driver runs: a successful route, a 500, a throw, a
refused settlement, an oversized response, a route past the validity window,
a lock lost during the route, and a throwing `authorize`, each asserting the
`/settle` count. A gate failure during two-phase settlement is answered like
any throwing gate, 502 with the fixed body. Two-phase attempts report to the
gate observer from #344 exactly as single-shot ones do; an abandoned payment
is recorded as `failed`, and the latency includes the route's run.

Technical shape: `createPaywall` and route tables return a `PaywallGate`
(the single-shot function plus `authorize`). The payment logic stays in the
server; the adapters only hold the response. Express and Fastify hold the
Node `ServerResponse` through the exported `holdNodeResponse`; Hono and Next
read the Web `Response` through `readBodyWithin`. Hono and Next detect a
thrown route error directly; Express and Fastify detect it by the status
their error handler writes, 500 by default. The full contract is in
docs/two-phase-settlement.md, with the failure rows in docs/failure-modes.md.

scenario-impact is `none`: the mode is opt-in, and no scenario under
docs/scenarios/ exercises it yet.
