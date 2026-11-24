---
date: 2026-11-24
feature: Multi-tenant isolation across service stores, routes, cursors and quotas
scope: feat
packages: ["@vegaforge/tollway-service"]
scenario-impact: none
---

# Multi-tenant isolation in the shared service

`@vegaforge/tollway-service` now scopes every stored record and HTTP route to an organisation and project (`{ orgId, projectId }`), making one shared service deployment safe to partition across multiple teams and projects.

Every configured tenant API key in `TOLLWAY_SERVICE_API_KEYS` binds to one `orgId` and `projectId`, and request tenancy is derived solely from the authenticated key rather than path, query or body inputs. `ReceiptStore`, `MetricsStore`, `ChannelStore`, `PolicyStore` and `AuditStore` take `TenantScope` on every method and partition records by composite `(orgId, projectId, id)` keys, so identical receipt IDs, channel IDs and agent IDs coexist across projects without conflict. Cross-tenant inspection is separated onto `AdminStore` and `GET /v1/admin/tenants`, gated by dedicated `operatorKeys` (`TOLLWAY_SERVICE_OPERATOR_KEYS`) that return per-tenant record counts only and cannot call tenant routes.

Pagination cursors on `/v1/receipts`, `/v1/channels`, `/v1/channels/{id}/commitments` and `/v1/audit` are signed with HMAC-SHA256 over `(orgId, projectId, route, query)` and verified in constant time, returning `400` when replayed under another key or with altered filters. Batch ingest endpoints (`POST /v1/ingest`, `POST /v1/metrics`, `POST /v1/receipts`) reject batches whose items claim another tenant with `403 tenant-mismatch` before verification or storage, and optional per-tenant quotas (`maxIngestItemsPerMinute` and `maxStoredRecords`) return `429` with `Retry-After`. For PostgreSQL backends, `serviceTenantMigrations` and `withTenantTransaction` pair composite primary keys with forced row-level security (`ENABLE` and `FORCE ROW LEVEL SECURITY` using transaction-local `set_config`), and the service documentation explains both the shared-instance operator trust boundary and how to run one instance per tenant when hard infrastructure separation is required.

Closes #231.
