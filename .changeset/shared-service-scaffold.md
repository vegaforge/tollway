---
"@vegaforge/tollway-service": minor
---

New package: the optional, self-hosted shared service. `createService` returns
a Hono app with typed configuration parsed from the environment or a JSON
file, API-key authentication (SHA-256 hashed keys, constant-time comparison,
`read`, `ingest` and `admin` scopes), `/healthz`, `/readyz` with a check per
store, and `/openapi.json` generated from the zod schemas that validate each
route. Receipts, metrics, channels and policies sit behind store interfaces
with in-memory implementations. The `tollway-service` binary listens on Node
and hashes keys with `tollway-service hash-key`.
