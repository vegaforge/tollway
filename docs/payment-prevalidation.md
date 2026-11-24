# Local payment pre-validation

Before the gate spends a facilitator `/verify` on an x402 payment, it decodes
the Stellar transaction inside it and runs the static checks the facilitator
runs before simulation (#159). A payment that cannot pass them is refused at
once with a 402 `payment-invalid`; one that passes still goes to `/verify`,
which stays authoritative. No local check can make an invalid payment valid.

Without it, every request carrying any `PAYMENT-SIGNATURE` costs a facilitator
round trip and an RPC simulation, so a flood of junk payments is cheap for an
attacker and expensive for the service and its facilitator quota.

## What is checked

In the order `@x402/stellar` 2.31's facilitator checks them. The reason is
sent as `upstreamReason` on the 402 and matches the facilitator's
`invalidReason` where the two overlap.

| Check | Reason |
| ----- | ------ |
| `PAYMENT-SIGNATURE` longer than the cap, before any decoding | `payment_signature_too_large` (Tollway's own) |
| `accepted.scheme` is not `exact` | `unsupported_scheme` |
| `accepted.network` is not the offer's network | `network_mismatch` |
| the envelope does not decode as a Stellar transaction (a fee-bump envelope included) | `invalid_exact_stellar_payload_malformed` |
| not exactly one `invokeHostFunction` invoke-contract operation | `invalid_exact_stellar_payload_wrong_operation` |
| the contract is not the offer's asset | `invalid_exact_stellar_payload_wrong_asset` |
| the function is not `transfer` with three arguments | `invalid_exact_stellar_payload_wrong_function_name` |
| the recipient is not the offer's `payTo` | `invalid_exact_stellar_payload_wrong_recipient` |
| the amount is not the offer's amount, compared as integers | `invalid_exact_stellar_payload_wrong_amount` |
| no auth entries | `invalid_exact_stellar_payload_no_auth_entries` |
| an auth entry without address credentials | `invalid_exact_stellar_payload_unsupported_credential_type` |
| optional: an authorization already behind the latest ledger | `invalid_exact_stellar_signature_expired` (Tollway's own) |

Simulation, fees, signatures and the "expires too far ahead" check stay with
the facilitator.

A wrong network passphrase cannot be detected here. The passphrase is not part
of the envelope bytes, only of the signature hash, and verifying signatures is
the facilitator's job. The network check uses the payer's `accepted.network`;
a transaction signed for the wrong network fails the facilitator's simulation.

The checks run after the settlement cache lookup, so a payment that already
settled is replayed even if its authorization has since expired, and before
`/verify`.

## Configuration

Pre-validation is on for every facilitator client except
`createMockFacilitator`, whose payments are not Stellar transactions. The mock
marks itself with `acceptsMockPayments: true`; never set that on a client that
talks to a real facilitator.

```ts
import { createLatestLedgerSource, createPaywall } from "@vegaforge/tollway-server";

const gate = createPaywall(config, {
  signer,
  facilitator,
  paymentPrevalidation: {
    // Characters; default 16 384. A real payment header is about 1.5 KiB.
    maxPaymentSignatureLength: 16_384,
    // Optional. Refuses authorizations already behind the latest ledger.
    latestLedger: createLatestLedgerSource({
      rpcUrl: "https://soroban-testnet.stellar.org",
      ttlMs: 5_000,
      onError: (error) => log.warn({ error }, "latest ledger unavailable"),
    }),
    // Every local refusal, with a running count, for flood monitoring.
    onRejected: ({ reason, resource, rejectedTotal }) =>
      metrics.increment("tollway.prevalidation.rejected", { reason }),
  },
});
```

The ledger is fetched at most once per TTL, shared between concurrent
requests, and only for payments that passed every other check, so junk traffic
never reaches Stellar RPC. When the lookup fails the expiry check is skipped for
that request, never failed, and the error goes to `onError`.

The asset must be a Soroban contract address (`C...`) for the asset check to
mean anything. A route configured with `CODE:ISSUER` would refuse every real
payment; `validatePaywall` and `createFacilitatorValidator` (#155) catch that
at startup.

`checkStellarExactPayment` is exported for callers that want the same checks
outside the gate.
