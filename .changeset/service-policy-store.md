---
"@vegaforge/tollway-service": minor
"@vegaforge/tollway-client": minor
---

Add versioned per-agent policy CRUD with `ETag`/`If-Match` optimistic concurrency, tombstone retirement, and an immutable structural-diff audit trail (`GET /v1/audit`) to `@vegaforge/tollway-service`, and add `fetchPolicy` with `If-None-Match` (`304`) caching to `@vegaforge/tollway-client`.
