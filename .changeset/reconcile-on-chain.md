---
"@vegaforge/tollway-reconcile": minor
---

Confirm x402 and MPP charge receipts on chain (#211) and check open channels against their contract state (#212).

- `reconcileCharge` reads the settlement transaction through a `ChainReader` and reports `tx-failed`, `tx-not-found`, `transfer-missing`, `amount-mismatch`, `payee-mismatch`, `payer-mismatch`, `asset-mismatch` and `network-mismatch`. A receipt older than the RPC retention window is `unverifiable`, and an RPC failure is `retryable`; neither is drift.
- `checkOpenChannel` and the pure `reconcileOpenChannel(snapshot, state)` report `closed-on-chain`, `recipient-mismatch`, `funder-mismatch`, `token-mismatch` and `balance-mismatch`.
- New subpath `@vegaforge/tollway-reconcile/stellar` with `createStellarChainReader`, `createStellarChannelStateReader`, `resolveAssetContractId`, `decodeTransferEvent` and `openChannelSnapshot`. The main entry imports neither the Stellar SDK nor `@stellar/mpp`.

Breaking: migrating from 0.0.x.

- `ReconciliationResult` now carries `status` (`"ok"`, `"drift"`, `"unverifiable"` or `"retryable"`) and a `subject` (`{ kind: "channel", channelId }` or `{ kind: "transaction", txHash, network }`) in place of `channelId`. Replace `result.channelId` with `reconciliationSubjectId(result.subject)`, and narrow with `result.status === "drift"` before reading `result.drift`; `result.ok` is still `true` only for a clean result.
- `ReconcilerOptions.suppress` receives the subject instead of a channel id string.
- `DriftWarnEvent` and `DriftQuarantineEvent` carry `subject` instead of `channelId`.
- Report entries gain `status` and `reason`; report totals gain `unverifiable` and `retryable`, and `byDriftKind` lists the new drift kinds.
