---
date: 2026-11-23
feature: Rolling-window and per-resource spending caps
scope: feat
packages: [@vegaforge/tollway-core]
scenario-impact: none
---

# Windowed per-service caps and per-resource caps

The policy engine gained two new ceilings on top of the lifetime
`perService.cap`:

- `perService[payee].dailyCap` resets at UTC midnight the same way
  `budgets.daily` does.
- `perService[payee].window = { windowSeconds, cap }` is a sliding
  rolling-window cap (for example 5 USDC per hour, 50 USDC per day).

A new `perResource` section mirrors the same three kinds (`cap`,
`dailyCap`, `window`) but keys off the resource identifier the receipt
carries, query string included. Entries default to exact matches; setting
`match: "prefix"` lets one entry cover a family of routes. Every entry that
matches a resource applies and is charged, so a narrower entry can tighten
a broader one but never lift its cap.

`createPolicyEngine` now refuses a policy whose `windowSeconds` is not a
whole number of seconds of at least 1, whose cap is not a base-unit integer
string, or whose `match` is not `exact` or `prefix`. The smart-account plan
reports the new caps as residual, since an account spending limit cannot
express them.

Window accounting is backed by a shared `RollingSum` accumulator with
bucketed, bounded-memory storage: at most `ceil(windowMs / bucketMs) + 1`
buckets are held per key, regardless of traffic. The accumulator may
over-count by at most one bucket's worth of spend at the window edge and
never under-counts, so caps fail closed. Idle keys are evicted once their
window drains, keeping the engine's memory steady under bursty traffic.

Every new rule evaluates even when an earlier rule fails, so a policy
trace shows the full picture: `per-service-daily`, `per-service-window`,
`per-resource`, `per-resource-daily`, and `per-resource-window` are each
reported with their limit, current, and projected values. The decision
still blocks on the first failure in evaluation order.

Pull request: #325. Closes #192.
