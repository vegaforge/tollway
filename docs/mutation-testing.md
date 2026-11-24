# Mutation testing

Line coverage says a test ran a line. Mutation testing asks a harder
question: if that line were wrong, would any test notice? Stryker answers it
by making one small change at a time to the production code (a `>` becomes
`>=`, a condition becomes `true`, a call is removed) and running the tests
that cover it. A change no test notices is a *surviving mutant*: a missing
test, or a line that does nothing. For a gate that moves money, that is the
question that matters. Issue #247 set the scope.

Mutation testing covers `@vegaforge/tollway-core` and
`@vegaforge/tollway-server`.

## Running it

| Command | What it does |
| --- | --- |
| `pnpm mutation` | A full run on both packages. It tests every mutant and writes `packages/<name>/reports/stryker-incremental.json` for later incremental runs. About 1.5 minutes for core and 5 for server on a laptop. |
| `pnpm mutation:incremental` | Re-tests only the mutants affected by changes since the last report in `packages/<name>/reports/stryker-incremental.json`. |
| `pnpm --filter @vegaforge/tollway-server exec stryker run --mutate "src/gate.ts:695-812"` | One file or line range, while you write a test. |

`pnpm test` and `./scripts/preflight.sh` never run Stryker, so they stay
fast. Each package writes an HTML and a JSON report to
`packages/<name>/reports/mutation/`. Open the HTML report to see every
surviving mutant next to its line.

Each package has its own `stryker.config.mjs`. It mutates every file under
`src/` except tests and the `index.ts` re-export barrel. No production file
is excluded to raise the score.

## In CI

`.github/workflows/mutation.yml` runs in two ways:

- On a pull request that touches `packages/core` or `packages/server`, it
  restores the report from the last full run and runs incrementally, so only
  the mutants your change affects are tested again. A pull request never
  saves that report, so a branch cannot plant a baseline later runs trust.
- Every Monday, and on manual dispatch, it does a full run and saves the
  report that pull requests restore.

Both upload the reports as a workflow artifact. The check is advisory: it is
not part of the `quality` aggregate, and branch protection does not require
it.

## The break threshold

Each config sets `thresholds.break`. A run whose score falls below it fails,
and the clear-text report in the log lists the surviving mutants. The
threshold was set from the score after the first round of fixes, and it only
ever goes up. Lowering it to make a pull request pass is masking a problem,
which AGENTS.md Directive 4 forbids. Kill the mutant with a test instead, or
show it is equivalent.

## Equivalent mutants

An *equivalent mutant* changes the code without changing what it does, so no
test can kill it. Each one is listed here with the reason, instead of a
`// Stryker disable` comment in the code.

| File and line | Mutant | Why it is equivalent |
| --- | --- | --- |
| `server/src/gate.ts`, `toOutcome`, `if (body.version === 2 && (waited \|\| result.replayed))` | the condition becomes `true` | A receipt this request has just settled was built from this offer and method, so re-hashing the offer gives the same `offerHash`. The condition only skips work. |
| `server/src/gate.ts`, `settleOnce`, `cache.release?.(key, lock) ?? Promise.resolve(false)` | `?.` becomes `.` | `settleOnce` returns early unless `cache.release` exists, and `createPaywall` refuses a cache with only part of the lock interface, so `release` is always defined here. |
| same line | `Promise.resolve(false)` becomes `Promise.resolve(true)` | The fallback is unreachable for the same reason. |

## Baseline

The first full run, on `dev` at the merge of #327, before any fixes. Score is
killed and timed-out mutants over all valid mutants.

| Package | Score | Covered score | Killed | Timeout | Survived | No coverage |
| --- | --- | --- | --- | --- | --- | --- |
| core | 72.47% | 77.79% | 1675 | 10 | 481 | 159 |
| server | 67.70% | 75.29% | 1714 | 32 | 573 | 260 |

The money-safety branches of `server/src/gate.ts` that #247 names (the
receipt binding check in `toOutcome`, the cache re-check after the lock is
taken, and the release-failure handling in `settleOnce`) had 32 surviving or
uncovered mutants. The tests under "settlement lock edge cases (#247)" in
`gate.test.ts` kill all of them except the three equivalent mutants above.
That slice of the gate now scores 97.25%.

## After the first fixes

| Package | Score | Covered score | `break` threshold |
| --- | --- | --- | --- |
| core | 72.47% | 77.79% | 72 |
| server | 68.94% | 76.08% | 68 |

`gate.ts` went from 73.03% to 78.13%, and `cache.ts` from 80.49% to 82.11%.
The largest remaining gaps are listed per file in the HTML report. In server
they are `channel-watchtower.ts` (21%), `route-table.ts` (57%) and
`service-policy.ts` (62%); in core, `receipt/schema.ts` (53%) and
`receipt/ecdsa.ts` (63%). Raise the threshold as each is closed.
