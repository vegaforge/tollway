---
"@vegaforge/tollway-service": minor
---

Scope every record, store method, API key, pagination cursor, export, channel close trigger and ingest batch in `@vegaforge/tollway-service` to `(orgId, projectId)`.

- Require `orgId` and `projectId` on every configured API key, derive request tenancy exclusively from the authenticated key, and add separate `operatorKeys` + `AdminStore` (`GET /v1/admin/tenants`) for per-tenant record count overviews.
- Partition `ReceiptStore`, `MetricsStore`, `ChannelStore`, `PolicyStore` and `AuditStore` by composite `(orgId, projectId, id)` keys so identical receipt, channel and agent IDs coexist across projects without collision, and add `receiptsModule`, `policiesModule`, `ingestModule` and `adminModule`.
- Sign pagination cursors with HMAC-SHA256 over `(orgId, projectId, route, query)` (`400` on cross-tenant or cross-filter replay), reject batch ingest items claiming another tenant with `403 tenant-mismatch`, emit caller-chosen ingest event ids as `<orgId>/<projectId>/<id>` so tenants sharing one observability hub cannot collide on webhook dedupe, add optional per-tenant `quotas` (`maxIngestItemsPerMinute`, `maxStoredRecords`) returning `429` with `Retry-After`, and ship PostgreSQL composite-key + forced RLS helpers (`serviceTenantMigrations`, `withTenantTransaction`).
