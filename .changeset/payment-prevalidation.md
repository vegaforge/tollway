---
"@vegaforge/tollway-server": minor
---

Pre-validate x402 payments locally before calling the facilitator (#159). The gate decodes the Stellar transaction and runs the static checks `@x402/stellar`'s facilitator runs before simulation (one invoke-contract `transfer` on the offer's asset, to its payee, for its amount, with address-credential auth entries). A payment that fails is a 402 `payment-invalid` whose `upstreamReason` is the facilitator's `invalidReason` name, and never costs a `/verify`. `PAYMENT-SIGNATURE` is capped at 16 384 characters before decoding. `PaywallDeps.paymentPrevalidation` tunes the cap, adds an optional latest-ledger source (`createLatestLedgerSource`) that refuses already-expired authorizations and skips the check when RPC is down, and reports every refusal to `onRejected` with a running count. `checkStellarExactPayment` is exported.

Pre-validation is on for every facilitator client except `createMockFacilitator`, which now sets `acceptsMockPayments: true`. A custom test stub that sends non-Stellar payments through the gate must set it too.
