# Receipt archive, MPP charge settler and service sink

## Added
- `ReceiptArchive` in `@vegaforge/tollway-observability` (in-memory implementation). Idempotent by receipt id, rejects conflicting bodies, filters on payer, payee, model, network, asset, resource, time range and settlement reference, and paginates newest first with opaque cursors.
- `createServiceSink` in `@vegaforge/tollway-observability`: batched, bounded and retrying transport to the service, with idempotency keys and a deadline-bounded close.
- `createMppChargeSettler` in `@vegaforge/tollway-client`.

## Not yet done
- SQLite archive implementation and conformance suite (#222).
- Service ingest and query routes; the sink targets `POST /v1/ingest`, which does not exist yet (#225 and #224).
- MPP settler dependencies (`@stellar/mpp`, `mppx`) are not declared and the lockfile is not regenerated.
