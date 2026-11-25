---
"@vegaforge/tollway-channels": minor
"@vegaforge/tollway-core": minor
---

Add compare-and-set to the channel commitment store, a `network` filter on `listChannels`, and PostgreSQL and Redis commitment stores.

- `CommitmentStore.appendCommitment` now takes an expectation (sequence, status, time) and advances the channel atomically, or throws `CommitmentConflictError`. `transitionChannel` is new. Custom stores must implement both, and `listChannels` must follow the shared rules in `store-query.ts`: newest first by `openedAt` then id, an opaque cursor, a page size from 1 to 200, and a `RangeError` for a bad size or cursor. Run the conformance suite in `testing/store-conformance.ts` to check one.
- `createPostgresCommitmentStore` and `createRedisCommitmentStore` are new. The PostgreSQL migration lives at `packages/channels/migrations/0001_commitment_store.sql`.
- `@vegaforge/tollway-core` gains the error codes `commitment-conflict`, `invalid-store-config` and `corrupt-channel-record`.
