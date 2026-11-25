---
date: 2026-11-25
feature: Reserve policy budget before settlement so concurrent payments cannot overspend
scope: fix
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-client"]
scenario-impact: none
---

# Reserve policy budget before settlement so concurrent payments cannot overspend

`pay()` checked the budget, called the settler, then recorded the spend. Payments started while another was settling all passed the same check. With a daily budget of 20000 and offers of 10000, ten concurrent payments all settled.

## What changed

- **Reservations.** `PolicyEngine.reserve` evaluates a payment as `admit` does and, when it is allowed, holds its spend against every budget, window, per-service and per-resource cap, and the anomaly window. `commit` makes the hold final. `release` gives it back.
- **Holds lapse.** A hold that is never committed or released expires after `reservationTtlMs` (five minutes by default). Its spend is given back, and `onReservationExpired` is called. A hold committed after it lapsed counts again, so money that moved is never dropped.
- **`commit` and `release` are strict.** Both are idempotent. Committing a released hold, releasing a committed hold, and using a handle from another engine all throw `PolicyReservationError`.
- **`pay()` order.** The client reserves before the settler is called, and commits as soon as the settler returns, before the receipt is checked. It releases only when the failure is `retryable-with-fresh-auth` or a channel that never opened. Every other failure, including ambiguous and fatal ones, keeps the spend.
- **Engines without `reserve`** keep the old path: `admit`, then `record` after settlement.

## Technical shape

Each ledger change returns the step that undoes it. Calendar ledgers undo into the period the spend was counted in. Rolling sums undo only while their bucket still counts toward the window. Daily maps undo only on the day they were written. A hold that outlives midnight therefore gives back to the right period.

## Verification

Regression tests in `packages/client/src/client.test.ts` cover ten concurrent payments against a budget that fits two, and a receipt that fails verification after settlement. Unit tests in `packages/core/src/policy-reservation.test.ts` cover holds, releases, commits, foreign handles and expiry. Nothing has been run. The tests were written and the code was checked by reading it.
