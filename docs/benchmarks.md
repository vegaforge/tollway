# Benchmarks

Tollway's payment gate does hashing, canonicalisation and signing on every
request. The benchmark suite measures how long that takes, and a CI check
compares a pull request against its base so the hot path cannot get slower
without anyone noticing. Issue #248 set the scope and the rule.

The suite lives in the private workspace package `packages/bench`
(`@vegaforge/tollway-bench`). It is never published. It depends on `core`,
`server` and all four adapters, which an adapter package may not do itself
(see `.claude/skills/tollway-engineering-standards/SKILL.md`,
"Architecture").

## What each benchmark measures

Every benchmark is deterministic: fixed inputs, a signer generated once
before anything is timed, the mock facilitator and mock MPP handler (no
network), and payment credentials from a counter, not a random source.
Each task warms up for 250 ms (and at least 50 calls) and then samples for
one second. Every task checks the outcome it got (a 402, a fresh settlement,
a replay), so a benchmark that took the wrong branch fails instead of timing
the wrong thing.

A *gate-level* benchmark is one the CI check can fail on. A
*micro-benchmark* times one step of the gate in isolation, so a gate-level
regression can be traced to its cause; the check reports it but never fails
on it.

| File | Benchmark | Scope | What it measures |
| --- | --- | --- | --- |
| `gate.bench.ts` | 402 challenge | gate | A request with no payment: build the offer, read the headers, encode the `PAYMENT-REQUIRED` challenge. |
| | x402 fresh settlement | gate | A new x402 payment: verify, cache miss, settle, build and sign the receipt with Ed25519, write the cache, bind the receipt to the offer, encode `PAYMENT-RESPONSE`. |
| | x402 replayed settlement | gate | The same payment again: verify, cache hit, offer binding, header encoding. No settlement. |
| | mpp-charge fresh settlement | gate | A new MPP charge credential (`Authorization: Payment ...`) through the mock MPP handler, otherwise as the fresh x402 case. |
| | x402 16 concurrent identical payments | gate | 16 callers send one new payment at the same moment. One sample is the time until all 16 have an answer; exactly one settles and 15 wait on it. |
| `redis.bench.ts` | x402 fresh settlement, x402 replayed settlement | gate | The same two paths with `createRedisSettlementCache` over `ioredis-mock`, which adds the SET NX lock, the second lookup under the lock, the Lua release, and the JSON round trip and schema parse of a stored receipt. |
| `adapters.bench.ts` | 402 challenge, x402 fresh settlement, per adapter | gate | Each adapter through its own entry point: Express over a real loopback socket (`app.listen(0)`) with Node's keep-alive `fetch` as the client, Fastify through `inject`, Hono through `app.request`, Next by calling the `withPaywall` handler with a `Request`. |
| `micro.bench.ts` | canonicalJson receipt body, canonicalJson offer binding | micro | `canonicalJson` on a full receipt body (what is signed) and on the six-field binding the gate builds twice per settled request. |
| | buildReceipt (schema parse) | micro | Assembling and schema-checking a receipt body. |
| | signReceipt (Ed25519), verifyReceipt (Ed25519) | micro | Signing a receipt, and verifying one with `Ed25519Verifier`. |
| | encodeHeader receipt, decodeHeader receipt | micro | The JSON and base64url encoding of the `PAYMENT-RESPONSE` header, and the reverse. |
| | nonce digest (SHA-256, 600-byte payload) | micro | The idempotency-key digest: UTF-8 encode, SHA-256 over WebCrypto, base64url. It calls `deriveMppChargeNonce`; the x402 HTTP facilitator's `deriveNonce` is not exported and does the same three steps. |

The Redis numbers measure Tollway's lock and cache code plus `ioredis-mock`,
which answers in process. They say nothing about a real Redis, where every
call is a network round trip. See "Findings" for how much of that time is
the mock.

The fresh-settlement benchmarks run against an in-memory cache that starts
full (10 000 entries, the default cap), so every sample pays for evicting
the oldest entry, as a busy production gate does.

## Running it

```bash
pnpm bench
```

This builds the packages the suite imports, runs `vitest bench`, prints a
table per file, and writes `packages/bench/results/bench.json` (ignored by
Git). It takes about 35 seconds. It is not part of `pnpm test` or
`./scripts/preflight.sh`. The unit tests of the comparison script
(`packages/bench/src/compare.test.ts`) are, and they run with `pnpm test`.

To compare two checkouts on your own machine, the way CI does:

```bash
# Both trees need `pnpm install`; the suite is taken from the head tree.
scripts/bench-compare.sh ../tollway-base . /tmp/bench-compare
```

To compare two results you already have:

```bash
pnpm --filter @vegaforge/tollway-bench compare --base base.json --head head.json
```

Vitest marks benchmarking as experimental and asks users to pin its version.
The bench package pins `vitest` to `4.1.12` because the comparison script
reads Vitest's benchmark JSON. The rest of the repository keeps `^4.1.12`.
The script validates that JSON with a schema, so a format change after an
upgrade fails loudly instead of comparing nonsense.

## Baseline

Measured with `pnpm bench` on 2026-11-19 at commit `7dd50f9` (the `dev`
branch this suite was added on). Times are per operation.

- Machine: Apple M5 Pro, 18 cores, 24 GB, macOS 27.2.1
- Node 22.17.1 (the repository's `.nvmrc` is `22`), Vitest 4.1.12
- The machine was shared with other work: the 1-minute load average was
  3.4 to 3.8 during the run. Treat the numbers as a scale, not a contract.
  CI never compares against them; it measures base and head itself.

| Benchmark | Median | p99 |
| --- | ---: | ---: |
| gate: 402 challenge | 2.8 µs | 3.5 µs |
| gate: x402 fresh settlement | 69.0 µs | 104.5 µs |
| gate: x402 replayed settlement | 11.2 µs | 15.9 µs |
| gate: mpp-charge fresh settlement | 69.1 µs | 111.1 µs |
| gate: x402 16 concurrent identical payments (all 16) | 274.5 µs | 505.0 µs |
| redis (ioredis-mock): x402 fresh settlement | 255.5 µs | 3242.9 µs |
| redis (ioredis-mock): x402 replayed settlement | 14.5 µs | 20.3 µs |
| express: 402 challenge | 98.9 µs | 174.9 µs |
| express: x402 fresh settlement | 170.8 µs | 263.1 µs |
| fastify: 402 challenge | 14.1 µs | 29.0 µs |
| fastify: x402 fresh settlement | 82.5 µs | 118.2 µs |
| hono: 402 challenge | 9.4 µs | 14.6 µs |
| hono: x402 fresh settlement | 78.9 µs | 108.9 µs |
| next: 402 challenge | 8.8 µs | 14.1 µs |
| next: x402 fresh settlement | 78.8 µs | 109.6 µs |
| micro: canonicalJson receipt body | 2.0 µs | 2.7 µs |
| micro: canonicalJson offer binding | 0.9 µs | 1.3 µs |
| micro: buildReceipt (schema parse) | 0.5 µs | 0.9 µs |
| micro: signReceipt (Ed25519) | 38.1 µs | 52.0 µs |
| micro: verifyReceipt (Ed25519) | 77.9 µs | 98.4 µs |
| micro: encodeHeader receipt | 6.2 µs | 7.8 µs |
| micro: decodeHeader receipt | 2.6 µs | 3.2 µs |
| micro: nonce digest (SHA-256, 600-byte payload) | 13.0 µs | 19.9 µs |

Express is slower than the other adapters on both paths because it is the
only one measured over a real socket: the client, the HTTP parser and the
loopback connection are part of every sample.

## Findings

These are what the baseline shows about where the time goes. None is
optimised in this change; each is a candidate for a follow-up issue.

1. **Signing dominates a fresh settlement.** `signReceipt` takes 38.1 µs of
   the 69.0 µs fresh x402 settlement, about 55%. This is the Ed25519
   signature itself and is expected.
2. **Header encoding dominates a replay.** `encodeHeader` takes 6.2 µs of
   the 11.2 µs replayed settlement, about 55%. In a one-off measurement on
   the same machine (Node 24.4.1), `JSON.stringify` of the 650-byte receipt
   took 0.75 µs of that; the rest is `bytesToBase64Url` in `core`, which
   builds the string one byte at a time. `Buffer`'s base64url encoder did
   the whole job in 1.25 µs, but `core` avoids `Buffer` so it runs on edge
   runtimes, so a fix would be an edge-safe chunked encoder.
3. **Concurrent waiters each re-encode the same receipt.** Of the 16 callers
   sharing one payment, the 15 that wait still run the offer binding and
   `encodeHeader` for an identical receipt: roughly 15 × (6.2 + 2 × 0.9) µs,
   about 120 µs of the 274.5 µs sample.
4. **The offer binding is canonicalised on every settled request.** The gate
   canonicalises the offer's six binding fields and the receipt's on every
   settled request (two calls at 0.9 µs each). The offer side is constant
   per route and request URL. That is about 16% of a replay and under 3% of
   a fresh settlement, so it matters for replays and waiters, not for fresh
   payments.
5. **`ioredis-mock`'s Lua interpreter dominates the Redis fresh path.** One
   `eval` of the release script took 169.5 µs in the one-off measurement,
   against 0.4 µs for a `get` and 1.1 µs for a `SET NX PX`. The fresh
   settlement with the Redis cache (255.5 µs) is therefore mostly the mock,
   and its p99 (3.2 ms) is the mock's garbage collection. A regression in
   Tollway's lock code smaller than the mock's own variance will not show
   up there; the replayed path (14.5 µs, no `eval`) is the sharper signal.
6. **`verifyReceipt` imports the public key on every call.** `importKey` took
   6.6 µs of a 77.9 µs verification in the one-off measurement. This is on
   the receipt consumer's side, not the gate's hot path.

## The CI check

`.github/workflows/bench.yml` runs on pull requests that touch
`packages/server`, `packages/core`, `packages/adapter-*`, `packages/bench`,
`scripts/bench-compare.sh` or the workflow itself. It is advisory: it is not
part of the `quality` aggregate, and branch protection does not require it.

In one job on one runner it checks out the pull request (merged into its
base, as the other CI jobs test it) and the base commit, installs both, and
runs `scripts/bench-compare.sh`. The script builds both trees and runs the
head's suite against each tree's build in turn, by swapping the built
`dist/` folders of the packages under test. The harness is therefore the
same on both sides, and only Tollway's code differs. Third-party
dependencies come from the head for both runs, so a pull request that only
bumps a dependency is not measured here.

The rule, agreed in issue #248:

- A gate-level benchmark **regresses** when its head median is more than
  **15%** slower than its base median.
- A change of **5%** or less either way is **noise** and is reported as
  unchanged.
- One **round** is a base run and a head run. A round with a regression
  triggers another, up to **three** rounds. A benchmark fails the check only
  if it regressed in at least **two** of them. Rounds alternate which side
  runs first, so a runner that speeds up or slows down during the job does
  not always favour one side.

The thresholds are not raised to make a pull request pass (AGENTS.md,
Directive 4). A real regression is fixed, or a maintainer accepts it
explicitly in review.

If the suite fails on the head build, the job fails. If it fails on the
base build, for example because a new benchmark uses an API the pull
request adds, the benchmarks it could not run show as "new (no base)" and
the summary says why.

### Reading the table

The job summary starts with the verdict:

- **Pass.** Nothing regressed, or a regression appeared in one round and did
  not repeat.
- **Fail.** It names each benchmark that regressed in two rounds.

A second table lists every benchmark that regressed in any round and in how
many. The main table shows the last round:

| Column | Meaning |
| --- | --- |
| Benchmark | `<file> > <describe block> > <benchmark>`. |
| Scope | `gate` can fail the check; `micro` is for attribution only. |
| Base median, Head median | Median time per operation, in microseconds. This is what is compared. |
| Change | `(head - base) / base`. Positive is slower. |
| Base p99, Head p99 | 99th percentile, for context. A shared runner's tail is noisy, so p99 is shown but not gated. |
| Status | `REGRESSED` (gate-level, over 15%), `slower` (over 5%, or a micro-benchmark over 15%), `unchanged` (within 5%), `faster` (more than 5% faster), `new (no base)`, `removed`. |

When a gate-level row regresses, look at the micro rows of the same round:
the step whose median moved by a similar absolute amount is the likely
cause.

### Evidence that the check works

On the machine above, `scripts/bench-compare.sh` was run twice with `dev` as the base:

- **Unchanged code passes.** With no code change, the machine under heavy
  load from other work (load average up to 24), three benchmarks crossed 15%
  in one round each and none repeated, so the run passed after three rounds.
  This is the case the repeat rule exists for.
- **An artificial slowdown fails.** With a 40 µs busy wait added to every
  settled outcome in `gate.ts` (not committed), the run failed after two
  rounds, confirming regressions in the gate's fresh, replayed, mpp-charge
  and concurrent benchmarks, Hono's settled path, and the Redis replay.

The CI equivalents (two green runs on an unchanged base and a red run on a
throwaway branch with a delay) need the workflow on GitHub and are part of
the pull request.
