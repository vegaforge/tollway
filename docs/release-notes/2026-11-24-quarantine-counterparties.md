---
date: 2026-11-24
feature: Quarantine counterparties with reconciliation drift across channel manager and model router
scope: feat
packages:
  - "@vegaforge/tollway-core"
  - "@vegaforge/tollway-channels"
  - "@vegaforge/tollway-reconcile"
  - "@vegaforge/tollway-client"
scenario-impact: none
---

# Quarantine counterparties with drift

Reconciliation drift now feeds a `CounterpartyQuarantine` list that stops new channel commitments to misbehaving counterparties while keeping `close` available to settle or recover open channels.

`@vegaforge/tollway-core` adds `CounterpartyQuarantine`, `createMemoryQuarantine` (with manual audited release by default), the `"counterparty-quarantined"` `TollwayErrorCode`, and quarantine-aware routing in `createDefaultRouter` that excludes `mpp-channel` and fails closed on lookup errors. `@vegaforge/tollway-channels` adds `quarantine` enforcement to `createChannelManager` (`open` and `commit` throw `CounterpartyQuarantinedError`; `close` stays allowed). `@vegaforge/tollway-reconcile` adds `createQuarantineEnforcer` with conservative `DEFAULT_DRIFT_ACTIONS` (`under-settled`, `recipient-mismatch`, and `token-mismatch` quarantine) and per-result deduplication, without adding a dependency on `@vegaforge/tollway-channels`. `@vegaforge/tollway-client` emits `counterparty:quarantined` events when a quarantined counterparty is encountered.

The client also refuses an explicit `model: "mpp-channel"` for a quarantined counterparty, since an explicit model skips the router. `createQuarantineEnforcer` bounds its deduplication memory with `maxRememberedResults` (default 10000).

Pull request: #333.
