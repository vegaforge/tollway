---
date: 2026-11-19
feature: real MPP charge, a Stellar MPP channel adapter, an x402 client settler, and a bounded settlement cache
scope: feat
packages: ["@vegaforge/tollway-server", "@vegaforge/tollway-channels", "@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Real Stellar settlement for MPP and the agent client

`createMppChargeHandler` now accepts MPP charge payments on Stellar through
`mppx` 0.6.31 and `@stellar/mpp` 0.7.1. A route that accepts `mpp-charge`
adds the `WWW-Authenticate: Payment ...` challenge `mppx` builds to its 402,
reads the agent's credential from `Authorization: Payment ...`, checks it
offline, dedupes retries through the settlement cache, and only then settles
on chain. The receipt has `model: "mpp-charge"` and the transaction hash. The
x402 path is unchanged. For `mpp-charge`, the paywall `asset` must be the
SEP-41 contract address the handler charges.

`createStellarMppChannelAdapter` in `@vegaforge/tollway-channels` drives a
deployed one-way-channel contract: it checks the contract on open, signs
cumulative commitments off chain, and closes with one transaction.

`createX402Settler` in `@vegaforge/tollway-client` pays x402 V2 routes on
Stellar with `@x402/stellar` 2.16.0 and returns the Tollway receipt from
`TOLLWAY-RECEIPT`. It refuses a 402 that asks for more than the approved
offer.

`createInMemorySettlementCache(ttlMs, { maxEntries, now })` caps its size
(10 000 by default, oldest evicted first) and sweeps expired entries on every
write, with no background timer.

Decision: ADR-2026-11-19-stellar-sdk-settlement. Issues #100, #101, #102,
#103.
