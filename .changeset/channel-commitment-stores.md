---
"@vegaforge/tollway-channels": minor
"@vegaforge/tollway-core": minor
---

Add compare-and-set to the channel commitment store, a `listChannels` query, and PostgreSQL and Redis commitment stores.

- `CommitmentStore.appendCommitment` now takes an expectation (sequence, status, time) and advances the channel atomically, or throws `CommitmentConflictError`. `transitionChannel` is new. `listChannels` is new. Custom stores must implement these. Run the conformance suite in `testing/store-conformance.ts` to check one.
- `createPostgresCommitmentStore` and `createRedisCommitmentStore` are new. The PostgreSQL migration lives at `packages/channels/migrations/0001_commitment_store.sql`.
- `@vegaforge/tollway-core` gains the error codes `commitment-conflict`, `invalid-channel-query`, `invalid-store-config` and `corrupt-channel-record`.
