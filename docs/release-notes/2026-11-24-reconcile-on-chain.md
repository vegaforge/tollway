---
date: 2026-11-24
feature: Confirm charge receipts on chain and check open channels against their contract state
scope: feat
packages: ["@vegaforge/tollway-reconcile"]
scenario-impact: none
---

# On-chain charge confirmation and live channel checks

Reconciliation now reads the chain. `reconcileCharge` confirms that an x402 or MPP charge receipt's transaction succeeded on the receipt's network and carries a SEP-41 transfer of exactly the receipt's amount and asset from its payer to its payee (#211). `checkOpenChannel` compares an open channel with its contract's live state and flags a close under way, a wrong recipient, funder or token, and tokens that left the channel beyond what was committed (#212). Both run while there is still time to act, not only after a channel closes.

Chain access sits behind two interfaces in the main entry, `ChainReader` and `ChannelStateReader`, whose results are parsed with zod schemas before any comparison. The Stellar implementations live in the new `@vegaforge/tollway-reconcile/stellar` subpath: `createStellarChainReader` over Soroban RPC `getTransaction`, and `createStellarChannelStateReader` over `getChannelState` from `@stellar/mpp`. The main entry imports neither.

A result now says how the check ended. `status` is `ok`, `drift`, `unverifiable` (the transaction is older than the RPC server keeps, so the chain can neither confirm nor contradict the receipt) or `retryable` (the RPC failed or has not caught up). Only `drift` raises alerts or quarantines a counterparty. Fee-bumped and facilitator-sponsored transactions confirm normally, because the transaction's source account is never compared to the payer.

The balance rule reports only what the chain can prove. The channel contract's `top_up` and direct transfers raise its balance without an event, so a higher balance is never drift. Before a close takes effect, tokens leave only through payouts the funder signed, so a balance below the deposit minus everything committed is.

## Migration

`ReconciliationResult` carries `status` and a `subject` in place of `channelId`:

- Replace `result.channelId` with `reconciliationSubjectId(result.subject)`, or read `result.subject.channelId` or `result.subject.txHash` after checking `result.subject.kind`.
- Narrow with `result.status === "drift"` before reading `result.drift`. `result.ok` is still `true` only for a clean result, but `false` no longer implies a `drift` list.
- `suppress(drift, subject)` receives the subject instead of a channel id string.
- `DriftWarnEvent` and `DriftQuarantineEvent` carry `subject` instead of `channelId`.
- Report entries gain `status` and `reason`, and report totals gain `unverifiable` and `retryable`.

Documentation: `apps/web/src/content/docs/reconciliation.mdx`. Pull request: #347.
