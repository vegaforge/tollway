---
date: 2026-11-23
feature: Explicit rate-limit semantics: what is counted, over which windows, per which scope
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-client"]
scenario-impact: none
---

# Rate-limit semantics

The policy's `rateLimit` now says what it counts, over which windows, and per
whom. `requestsPerMinute` still works and means exactly what it did: settled
payments, across every payee, in any sliding minute.

- `windows`: one or more sliding windows that all apply, for example 60 per
  minute and 1000 per hour. An event counts while it is at most
  `windowSeconds` old. Setting `windows` and `requestsPerMinute` together is
  refused.
- `count`: `settlements` (the default) counts payments when they are
  recorded after settling. `attempts` counts every payment the client sends,
  at the moment it sends it, including ones that then fail and each retry
  with a fresh authorization. Payments the policy blocked are not counted.
- `scope`: `global` (the default) shares one count; `per-counterparty`
  keeps one per payee address and names the payee in the decision detail.
- `perCounterpartyKeyLimit` (default 1024, at least 1) caps how many payees
  are tracked. Idle payees are dropped first. When every tracked payee is
  still active, a new payee is refused until one goes idle, rather than
  forgetting an active payee and resetting its count.

The rate limit keeps its own log, separate from the one-minute anomaly window.
The log is exact, and holds at most as many timestamps per payee as the
largest limit.

`evaluate` and `check` never change state. The engine gains `admit`, which
evaluates a payment the caller is about to send and counts it as an attempt
in the same step, so concurrent attempts cannot all take the last slot of an
`attempts` limit; and `recordAttempt`, which the client calls on a shadow
engine. Both are optional on `PolicyEngine`, so existing custom engines still
fit. Reserving budget at check time across every rule is #189; this covers
the rate limit only.

Pull request: #329. Closes #197.
