---
date: 2026-11-24
feature: Shared, compare-and-set channel stores (PostgreSQL and Redis) and a conformance suite
scope: feat
packages: ["@vegaforge/tollway-channels", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Shared, compare-and-set channel stores

Channel state used to live only in the process that opened the channel. Two
processes sharing a store could both advance one channel, and two closes could
both reach the chain. Every write that depends on a channel's state is now a
compare-and-set, and the package ships PostgreSQL and Redis stores that keep
channel state across restarts and across processes.

## What changed

- **Compare-and-set in the contract.** `appendCommitment` advances `committed`,
  `sequence` and `lastCommitAt` only if the channel still has the expected status
  and sequence. `transitionChannel` moves the status only from the expected value.
  A lost race throws `CommitmentConflictError` and writes nothing. The manager
  commits and closes through these methods, and a losing close throws
  `ChannelAlreadyClosedError`.
- **`listChannels`.** A paged listing with exact-match filters on status,
  counterparty, asset and network, ordered by channel id. Page sizes outside
  1 to 500 throw `invalid-channel-query`.
- **PostgreSQL store.** `createPostgresCommitmentStore`, with migration
  `packages/channels/migrations/0001_commitment_store.sql`. Amounts are
  `NUMERIC(39, 0)`. An append is one transaction, and a primary key backs the
  sequence check.
- **Redis store.** `createRedisCommitmentStore`. Each conditional write is one
  Lua script, keyed by hash tag so it works on Redis Cluster. No key has a TTL.
- **Conformance suite.** `testing/store-conformance.ts` lists the cases every
  store must pass. It is not part of the published build.

## Breaking for custom stores

`CommitmentStore` changed. `appendCommitment` now takes an expectation and
returns the advanced channel. `transitionChannel` and `listChannels` are new.
A custom store must implement them. Use the conformance suite to check it.

## Not in this release

- Serialising racing commits and closes inside one process is the manager half
  of #175. Until it lands, a racing commit gets `CommitmentConflictError`.
- The real-database tests (a live PostgreSQL and a live Redis) need a dev
  dependency, which needs a maintainer to review `package.json` and the lockfile.
  The SQL and the Lua are unit-tested against scripted clients only.
- The migration is in the repository, not the npm package.

See [docs/channel-commitment-stores.md](../channel-commitment-stores.md) for
setup, isolation, and what happens on connection loss.

Closes #177, #178, #179 (see the pull request).
