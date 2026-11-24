---
date: 2026-11-23
feature: The optional self-hosted shared service, with API keys, health and readiness, and generated OpenAPI
scope: feat
packages: ["@vegaforge/tollway-service"]
scenario-impact: none
---

# Shared service scaffold

Teams that want budgets, receipts, metrics or channels shared across many
processes can now run `@vegaforge/tollway-service` themselves. This release is
the skeleton later features mount on: it serves `/healthz`, `/readyz`,
`/openapi.json` and `/v1/whoami`, and every `/v1` route requires an API key.

The service holds no key that signs receipts or moves funds and makes no
outbound call of its own; a test runs every route with `fetch` stubbed to fail.
API keys are configured as SHA-256 hashes, compared in constant time, and each
carries a name and `read`, `ingest` or `admin` scopes. A missing or unknown key
gets 401, a key without the route's scope gets 403, and no response or log line
contains a key, a hash or an `Authorization` header.

Configuration is parsed once at startup with zod, from `TOLLWAY_SERVICE_*`
environment variables or a JSON file, and a bad value stops startup with the
variable or field named. Routes are declared once as data: the same declaration
mounts the route, checks its scope, validates path, query and body, and
produces its entry in the OpenAPI 3.1 document, so the spec cannot drift from
the code. Receipts, metrics, channels and policies sit behind store interfaces
with in-memory implementations, and `/readyz` checks each one.

Docs: `apps/web/src/content/docs/service.mdx`. Pull request: #307.
