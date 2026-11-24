---
date: 2026-11-23
feature: Stryker mutation testing for core and server, with a ratcheting break threshold
scope: chore
packages: []
scenario-impact: none
---

# Mutation testing for core and server

Tollway now measures whether its tests would notice a wrong line, not only
whether they run it. `pnpm mutation` runs Stryker 10.1.1 with its Vitest
runner on `@vegaforge/tollway-core` and `@vegaforge/tollway-server`. A new
`Mutation` workflow re-tests the affected mutants on every pull request that
touches either package, and runs in full every Monday. Each package fails
its run when its score drops below a `break` threshold that only goes up.
`pnpm test` and `./scripts/preflight.sh` do not run it.

The first run found 32 untested mutants in the gate's money-safety branches:
the cache re-check after the settlement lock is taken, the lock release when
a settlement throws, and each way a lock release can fail. New tests in
`gate.test.ts` kill all of them except three equivalent mutants, which
`docs/mutation-testing.md` lists with the reason for each. Two tests that
read files relative to the working directory now find the repository root
themselves, so they also pass inside Stryker's sandbox. No published package
changed, so there is no changeset.

See `docs/mutation-testing.md`. Issue #247, pull request #320.
