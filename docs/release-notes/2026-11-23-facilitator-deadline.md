---
date: 2026-11-23
feature: Bounded facilitator deadlines, a hold for ambiguous settlements, and failure-injection tests
scope: fix
packages: ["@vegaforge/tollway-server"]
scenario-impact: none
---

# Bounded facilitator deadlines and ambiguous settlements

A hung facilitator no longer holds a request open indefinitely, and a timeout
can no longer let the same payment reach `/settle` twice.

Every `/verify` and `/settle` call is bounded by the new
`PaywallDeps.facilitatorTimeoutMs` (default 15 seconds), and
`createHttpFacilitator` accepts `timeoutMs` for the transport deadline, which
aborts the socket. A `/verify` that misses its deadline is rejected with 503
`facilitator-timeout`, because nothing has settled and a retry is safe.

A `/settle` whose outcome is unknown is held. That is a `/settle` that misses
the gate's deadline (answered with 503 `settlement-unknown`), and one that
fails after the request may have reached the facilitator: a transport timeout,
a reset or an error answer (the error is thrown as before). While a payment is
held, the gate keeps its in-flight slot and keeps renewing the cross-process
settlement lock, so no retry in any process calls `/settle` for it again. The
hold ends when the abandoned call answers, or after the new
`PaywallDeps.ambiguousSettlementHoldMs` (default 120 seconds, counted from the
start of the call). A late success is written to the settlement cache before
the hold ends, so a retry replays its receipt. A refused connection or a DNS
failure proves the request was never sent, so it frees the payment at once.

Before this change, the lock was released or left to expire at its TTL while
the abandoned call could still land, so a retry about 30 seconds later could
settle the same payment again.

Also in this change:

- the test-only harness in `packages/server/src/testing/faults.ts` scripts
  delays, hangs and rejections for a facilitator and for a Redis-compatible
  store, driven by fake timers;
- the invariant checker runs at the end of every scenario: at most one
  `/settle` per nonce, every receipt handed out verifies, the in-flight map is
  empty, and any lock left behind is bounded by its TTL;
- scenarios cover a hung or failing `/verify` and `/settle`, a late success, a
  refused connection, the HTTP transport deadline, a failing `/supported`,
  Redis faults (down, slow beyond the TTL, flapping, a foreign value), and two
  processes sharing one Redis;
- paths owned by #107, #161 and #162 are committed as `it.todo` naming those
  issues;
- `docs/failure-modes.md` lists each failure, the gate's answer, whether the
  payer may have been charged, and the operator action, linked from
  `docs/design.md`, "Failure semantics".

Pull request: #323. Closes #251.
