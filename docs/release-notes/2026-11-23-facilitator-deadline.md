---
date: 2026-11-23
feature: Bounded facilitator deadlines and failure-injection tests
scope: fix
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# Bounded facilitator deadlines and failure-injection tests

A hung facilitator no longer holds a request open indefinitely. Every `/verify`
and `/settle` call is bounded by the new `PaywallDeps.facilitatorTimeoutMs`
(default 15 seconds), and `createHttpFacilitator` accepts `timeoutMs` for the
transport deadline, which aborts the socket. `@x402/core` 2.31 already aborts its
own request after 90 seconds; the gate's deadline is what applies to any
`FacilitatorClient`, including a mock or a custom one.

The two outcomes differ on purpose. A `/verify` that misses its deadline is
rejected with 503 `facilitator-timeout` because nothing has settled and a retry
is safe. A `/settle` that misses its deadline is rejected with 503
`settlement-unknown` and `Retry-After` set to the settlement lock TTL: the
transaction may still land, so the lock is kept until its TTL and the in-flight
slot stays taken until the abandoned call answers or the TTL passes. If that
call later reports a settlement, its receipt is written to the settlement cache,
so a retry replays it instead of settling the payment again.

The new test-only harness in `packages/server/src/testing/faults.ts` scripts
delays, hangs, rejections and malformed answers for a facilitator and for a
Redis-compatible settlement store, drives them with fake timers, and checks the
same invariants after every scenario: at most one `/settle` per nonce, every
receipt handed to a caller verifies, the in-flight map empties, and a lock left
behind is bounded by its TTL. `docs/failure-modes.md` lists each failure, the
gate's answer, whether the payer may have been charged, and the operator action;
`docs/design.md` links to it from "Failure semantics".

Closes #251.
