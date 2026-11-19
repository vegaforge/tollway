---
date: 2026-11-19
feature: Benchmarks for the payment gate and the four adapters, with an advisory CI regression check
scope: chore
packages: []
scenario-impact: none
---

# Gate and adapter benchmarks

Tollway now measures how long its payment path takes, so a pull request that
makes it slower shows up with a number. Nothing a user of the published
packages sees has changed.

`pnpm bench` runs the suite in the new private workspace package
`packages/bench` (`@vegaforge/tollway-bench`) and writes
`packages/bench/results/bench.json`. It is not part of `pnpm test` or
preflight. The suite covers the gate on its own (402 challenge, fresh x402,
replayed x402, fresh mpp-charge, 16 concurrent identical payments), the gate
with `createRedisSettlementCache` over `ioredis-mock`, each adapter on the
challenge and settled paths through its own entry point, and
micro-benchmarks of canonicalisation, signing, verification, header encoding
and the nonce digest. The new workflow `.github/workflows/bench.yml` runs on
pull requests that touch `packages/server`, `packages/core`,
`packages/adapter-*` or the benchmarks themselves. It builds base and head
in one job, runs the suite on each, and fails when a gate-level median is
confirmed more than 15% slower. It posts the comparison table to the job
summary, and it is not part of the required `quality` check.
`docs/benchmarks.md` explains every benchmark, the baseline numbers, and how
to read the table.

Choices made while implementing issue #248:

- **Private bench package.** The adapter benchmarks need all four adapters
  and their frameworks in one place. Adapters must not depend on each other
  (SKILL.md, "Architecture"), so the suite lives in a private package that
  depends on them, the same way an app would. It is never published, so no
  changeset.
- **Vitest pinned to 4.1.12 in that package only.** Vitest marks benchmarking
  as experimental and asks users to pin it. The comparison script reads
  Vitest's benchmark JSON, so only the package that produces and reads that
  JSON pins it; the rest of the repository keeps `^4.1.12`. The script also
  validates the JSON with a schema, so a format change fails loudly.
- **The rule agreed in the issue thread (proposal in PR #278).** A gate-level
  median more than 15% slower than base is a regression, a change within 5%
  either way is noise, and a regression must repeat in 2 of up to 3 rounds
  (one round is a base run and a head run) to fail. Micro-benchmarks are
  reported but never fail the check, because they exist to attribute a
  gate-level regression to a step.
- **One harness for both sides.** The suite always comes from the head. The
  script builds base and head and swaps their built `dist/` folders under
  that one suite, so a change to a benchmark cannot pose as a change in
  speed. Third-party dependencies come from the head for both runs, so a
  dependency bump alone is not compared. Rounds alternate which side runs
  first. The script is `scripts/bench-compare.sh`, so it is under the
  sensitive-path review that covers `scripts/**`.
- **A base run that fails is reported, not fatal.** A benchmark that uses an
  API the pull request adds cannot run on the base; it shows as "new (no
  base)" with a note in the summary. A failing head run fails the job.

No production code changed. Bottlenecks the suite found are listed in
`docs/benchmarks.md` ("Findings") with numbers; none was optimised here.

Issue: #248.
