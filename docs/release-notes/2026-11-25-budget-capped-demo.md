---
date: 2026-11-25
feature: Budget-capped agent demo with policy stops and reconciliation drift
scope: feat
packages: ["@vegaforge/tollway-demo"]
scenario-impact: updated
---

# Budget-capped agent demo

`apps/demo` now ships the Phase 3 exit criterion from `docs/design.md` as a
runnable flow. `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo
start:budget-capped` prints a three-phase narrative an operator can follow, and
the same run is a vitest test in CI.

The first phase gives an agent built from `createClient` and
`createPolicyEngine` a daily budget of exactly three route prices. Payments 1
to 3 settle; payment 4 is refused with `PolicyBlockedError` and `rule:
"budget"` before the settler runs, so the mock facilitator receives exactly
three verify calls. The refused evaluation records no spend, which the demo
checks with a smaller amount that still fits the remaining budget. The second
phase loads a raised budget plus `anomaly.maxSpendPerMinute` and a burst on an
injected clock is stopped with `rule: "anomaly"` at the projected-minute
boundary.

The third phase shows the two drift guards together. A channel manager with an
offline adapter commits three times, then the adapter reports a settlement
below the last commitment; `close` throws `SettlementMismatchError` and the
channel returns to `open`. Passing the stored stream and the reported
settlement to `reconcileChannel` then flags `under-settled` with its shortfall,
and a stream with a missing commitment flags `sequence-gap`. Each drift is
emitted as `anomaly.detected` on an `ObservabilityHub` and printed by its local
handler; each policy stop is also a client `skip` event.

The demo-local settler in `apps/demo/src/scenarios/mock-settler.ts` runs the
real x402 V2 402, pay, retry exchange over HTTP against the mock facilitator.
It stays in the demo: the client package's real settlers are #102, #184 and
#185.

Docs: `apps/demo/README.md`. Closes #244.
