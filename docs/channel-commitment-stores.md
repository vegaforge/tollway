# Channel commitment stores

The channel manager keeps each channel's record and its commitment stream in a
`CommitmentStore`. This page covers the three stores that ship in
`@vegaforge/tollway-channels`, how to set each one up, and what each guarantees
when things go wrong. See [design.md](design.md), "The channel lifecycle
manager", for where the store sits in the lifecycle.

## The contract

Every write that depends on the state of a channel is a compare-and-set.

- `appendCommitment(commitment, { expectedSequence, expectedStatus, lastCommitAt })`
  advances `committed`, `sequence` and `lastCommitAt` only if the channel still
  has the expected status and sequence, and the commitment follows that
  sequence. Otherwise it throws `CommitmentConflictError` and writes nothing.
- `transitionChannel(channelId, expectedStatus, patch)` applies the patch only
  if the channel still has the expected status.
- `updateChannel` is unconditional. Use it only where no other writer can race it.

A lost race is always a typed error, never a silent overwrite. `field` on the
error says which condition failed: `sequence` or `status`.

The manager commits and closes through these methods. A commit signs first and
then appends. If the append loses a race, the signed blob is discarded with the
error, so a stale commitment is never returned to the caller. Two racing commits
on one channel leave one of them stored. The other gets `CommitmentConflictError`
and should retry. Queueing racing calls in process, so they do not conflict, is
the manager half of #175 and is not in this release.

## Memory store

`createMemoryCommitmentStore()` is the default. It is process-local and holds
nothing after a restart. Use it for tests and single-process agents.

## PostgreSQL

```ts
import { Pool } from "pg";
import { createPostgresCommitmentStore } from "@vegaforge/tollway-channels";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresCommitmentStore({ client: pool, schema: "tollway" });
```

**Setup.** Apply `packages/channels/migrations/0001_commitment_store.sql` once,
to an empty schema, with `search_path` set to that schema:

```sql
CREATE SCHEMA tollway;
SET search_path TO tollway;
-- then run packages/channels/migrations/0001_commitment_store.sql
```

Pass the same name as `schema`. The store qualifies every table with it. Omit
`schema` to use the connection's `search_path`. The schema name must be a plain
identifier, or the store refuses it with `invalid-store-config`.

The migration is not part of the npm package. Copy it from the repository. Later
migrations will be numbered in order, and each applies once.

**Amounts.** Stored as `NUMERIC(39, 0)`, which holds every value up to `2^127 - 1`
exactly, and read back as the integer string. A `CHECK` keeps `committed` from
passing `deposit`.

**Ordering.** The `id` and `opened_at` columns use collation `"C"`. The database
then orders channels the same way the store's JavaScript does, newest first by
`opened_at` and then id, so pages agree across stores. The listing is one keyset
query, and the migration indexes it with and without the status and
counterparty filters.

**Isolation.** Appends run at `READ COMMITTED`, which the store sets explicitly.
The compare-and-set is a conditional `UPDATE ... WHERE sequence = $n AND status = $m`.
Two racing appends meet on the row lock. The second waits for the first to
commit, then re-checks its `WHERE` against the new row and matches nothing.
The primary key `(channel_id, sequence)` backs this up: a duplicate sequence
cannot be stored even if a caller skipped the check. `REPEATABLE READ` would
turn the same race into a serialization error, which the store does not map.

**Connection loss.** Two cases.

- The connection drops before `COMMIT` is sent: PostgreSQL rolls the transaction
  back. Nothing is stored. The caller gets an error and can retry.
- The connection drops after `COMMIT` is sent, but before the reply arrives: the
  commitment may already be stored, and the caller cannot tell. Before retrying a
  commit after an error like this, call `listCommitments` and check whether the
  sequence is already there.

If a rollback fails, the store destroys that pool connection rather than return
it, and throws the original error.

**Tests.** The unit tests run the store against a scripted client and check the
SQL shape, the transaction boundaries and the conflict mapping. The full
conformance suite (below) passed against PostgreSQL 18 through `pg` with an
eight-connection pool, so its concurrent-append case raced real connections. CI
does not run it yet, because that needs a PostgreSQL service and a `pg`
development dependency. Run the suite against your own database before you rely
on it.

## Redis

```ts
import { Redis } from "ioredis";
import { createRedisCommitmentStore } from "@vegaforge/tollway-channels";

const store = createRedisCommitmentStore({ client: new Redis(process.env.REDIS_URL) });
```

**Keys.** The record of channel `C` is a hash at `tollway:ch:{C}:record`. Its
commitments are a sorted set at `tollway:ch:{C}:commitments`, scored by
sequence. A set `tollway:ch:index` lists the channel ids. The braces are a hash
tag, so both keys of one channel land in one Cluster slot, and each script
touches one slot. Set `keyPrefix` to change the `tollway:ch` prefix.

**Scripts.** Each conditional write is one Lua script: the append, the status
transition, and the patch. Scripts run by SHA. On `NOSCRIPT` the store sends
the script with `EVAL` once, which also loads it. Any other error is rethrown.

**Amounts.** Passed to and stored by Redis as strings. No amount becomes a Lua
number, because Lua 5.1 numbers are doubles and lose precision above `2^53`.

**No TTLs.** No channel or commitment key expires. A record that expired would
take the latest commitment with it, and the channel could no longer close with the
right amount.

**Persistence.** Redis loses data that it has not yet written to disk. Choose
the setting to match how much you can lose:

- `appendonly yes` with `appendfsync always` loses no acknowledged commitment on
  a crash, at a cost in write speed.
- `appendfsync everysec` can lose up to a second of acknowledged commitments.

**Failover.** Replication is asynchronous by default. If a primary fails after it
acknowledged a commitment but before a replica received it, the new primary does
not have that commitment. The same rule as PostgreSQL applies: after an error on
a commit, read `listCommitments` before you retry. If the commitments must survive
a failover, make the write wait for replicas (`WAIT`) or accept the window.

**Listings.** `listChannels` and `listChannelsByStatus` read the whole index, one
record at a time. That is fine for the sizes this store targets. A status index
is the next step if the number of channels grows.

**Tests.** As with PostgreSQL, the unit tests use a scripted client and do not
run the Lua. The full conformance suite passed against Redis 8.10 through
`ioredis`, running the real scripts. CI does not run it yet, for the same reason
as PostgreSQL.

## Running the conformance suite against a new store

Every store must pass the shared cases in
`packages/channels/src/testing/store-conformance.ts`. The suite is a list of
cases, each taking a factory that returns a fresh, empty store. It uses
`node:assert` only, so the published package does not include it. Write a test
file in `packages/channels/src/` that runs it:

```ts
import { describe, it } from "vitest";
import { commitmentStoreConformanceCases } from "./testing/store-conformance.js";
import { createMyStore } from "./stores/my-store.js";

describe("my store conformance", () => {
  for (const check of commitmentStoreConformanceCases) {
    it(check.name, () => check.run(() => createMyStore()));
  }
});
```

`store.conformance.test.ts` runs the suite against the memory store, and also
checks that a store whose appends ignore the expected sequence fails it. Keep
that second check in mind when you write a new suite: the suite must catch the
bug it exists for.

The suite covers round trips, patch semantics, ordering, isolation, exact amounts
up to `2^127 - 1`, every listing filter, paging, the compare-and-set conflicts,
concurrent writers, and a seeded run compared with a reference model.
