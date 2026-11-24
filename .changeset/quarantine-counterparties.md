---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-channels": minor
"@vegaforge/tollway-reconcile": minor
"@vegaforge/tollway-client": minor
---

Quarantine counterparties flagged by reconciliation drift across the channel manager, model router, and client:
- Add `CounterpartyQuarantine`, `createMemoryQuarantine`, `"counterparty-quarantined"` error code, and quarantine-aware `createDefaultRouter` in `@vegaforge/tollway-core`.
- Enforce quarantine in `createChannelManager` (`open` and `commit` throw `CounterpartyQuarantinedError`, `close` stays allowed, lookup failures fail closed) in `@vegaforge/tollway-channels`.
- Add `createQuarantineEnforcer` and `DEFAULT_DRIFT_ACTIONS` in `@vegaforge/tollway-reconcile` with per-result deduplication.
- Emit `counterparty:quarantined` events in `@vegaforge/tollway-client`.
