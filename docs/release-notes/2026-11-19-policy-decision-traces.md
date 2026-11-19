---
date: 2026-11-19
feature: policy decision traces, a dry-run policy mode, and shadow evaluation of a candidate policy
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-client"]
scenario-impact: none
---

# Policy decision traces, dry-run, and shadow policies

A blocked payment used to explain only the first rule that failed. Now
`engine.evaluate(intent)` returns a decision trace: every rule, in
evaluation order, with whether it is configured, its limit, the current and
projected values, its window, and `pass`, `fail` or `not-applicable`.
`engine.check(intent)` is built on it through `decisionFromTrace`, which the
client uses too, so the decision and its explanation cannot disagree. The
trace is a versioned JSON shape (`version: 1`) with amounts and counts as
integer strings, published as `policyTraceSchema` in
`@vegaforge/tollway-core`. The documentation, with a real trace and a
rollout recipe, is in `apps/web/src/content/docs/policy.mdx`, "Decision
traces" and "Dry-run and shadow policies".

A policy can set `mode: "dry-run"`. It evaluates and records spend exactly
as `enforce` does, but allows every payment; the trace marks the would-be
block with `wouldBlock` and `blockedBy`. `enforce` stays the default, an
unknown mode throws `invalid-policy`, and `createClient` logs a warning when
it is given a dry-run policy.

`createClient` emits `policy:decision` with the active trace before it pays
or blocks. A new `shadow` option takes a candidate `PolicyEngine`: the client
evaluates it next to the active policy, emits `policy:shadow` with both
traces and their differences (`comparePolicyTraces`), and records settled
payments on it so its budgets count real spend. A candidate that throws is
reported as `policy:shadow-error`; it never affects the payment.

`check()` returns the same decisions and failure details as before. A
seeded comparison against the previous engine over 5 000 random policies and
spend histories matched on every case, and a seeded property test keeps
`check().allowed` equal to "no failing entry in the trace".

Breaking for anyone implementing `PolicyEngine` themselves: the interface
now requires `mode` and `evaluate`. `PolicyDecision.rule` is narrowed from
`string` to the `PolicyRuleName` union of the values it already took.

Choices made where issue #200 left them open:

- `check()` is built on `evaluate`, not `reserve()`: #189 has not landed,
  so there are no reservations yet. Dry-run records spend through `record`
  exactly as enforce does; when `reserve()` arrives it must take and commit
  reservations in dry-run too.
- Every rule is evaluated even after one fails, so a malformed limit in a
  later rule now throws (`invalid-amount`) where it used to be skipped. A
  broken policy is refused rather than half-applied.
- `rateLimit.requestsPerMinute` must be a non-negative integer; a fraction
  throws `invalid-policy` instead of being compared as a float. The trace
  carries it as an integer string like every other limit.
- The trace keeps both rule names: a fine `id` (`budget-daily`,
  `budget-total`) and the existing `rule` (`budget`), so `check()`,
  `PolicyBlockedError` and the `skip` reason are unchanged.
- `configured` is true when the policy sets the rule at all; a rule set for
  another payee or model is `configured: true, outcome: "not-applicable"`.
- The shadow option takes a `PolicyEngine`, not a bare `Policy`, so the
  caller controls its clock. With no active policy, the candidate is
  compared with an empty policy, which is what "no policy" evaluates to.
- `policy:shadow` is emitted for every payment, including when both sides
  agree (`sameDecision: true`), so a quiet shadow is visibly running.
- Shadow evaluation and event construction are skipped when no handler is
  registered; shadow spend is still recorded.
- The dry-run warning goes to `console.warn` by default, or to a new
  `logger` option.
- The property test uses a small seeded generator in the test file rather
  than adding `fast-check` to `@vegaforge/tollway-core`, to avoid changing
  a `package.json` and the lockfile.

Issue #200.
