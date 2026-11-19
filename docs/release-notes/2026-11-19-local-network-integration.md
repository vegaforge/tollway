---
date: 2026-11-19
feature: x402 and MPP charge integration tests on a local Stellar network, in CI
scope: chore
packages: []
scenario-impact: none
---

# Integration tests on a local Stellar network

A new private workspace package, `tests/integration`
(`@vegaforge/tollway-integration-tests`), pays real Soroban transactions
through the gate on a disposable `stellar/quickstart` network, and a new
workflow, `.github/workflows/integration.yml`, runs it on every push and pull
request. No published package changed. The job is not in the `quality`
aggregate yet. Issue #245.

What it checks, all against chain state through RPC: an x402 payment through
an Express route settles with a verifiable receipt, `getTransaction` reports
`SUCCESS`, and the recipient's balance moves by exactly the offer amount; the
same `PAYMENT-SIGNATURE` sent concurrently settles once and replays; a payer
whose balance is spent after signing and a payment for the wrong amount are
rejected with no balance change; an MPP charge (#100) settles once and
replays. MPP channel (#101) is a todo. A harness self-test that runs in every
`pnpm test` checks that an unreachable node fails within its deadline.

Choices:

- The local network runs with the testnet passphrase. quickstart's local mode
  keeps a `NETWORK_PASSPHRASE` it is given (stellar/quickstart#688, and the
  image's `.do/deploy.template.yaml`), so `@x402/stellar` and `@stellar/mpp`
  accept it as `stellar:testnet` without a patch.
- An HTTPS proxy with a per-run certificate sits in front of the RPC, because
  the `@x402/stellar` client and `@stellar/mpp` build `rpc.Server` without
  `allowHttp` and quickstart serves plain HTTP. Node trusts the certificate
  through `NODE_EXTRA_CA_CERTS`.
- The suite lives in a private workspace package rather than under
  `packages/server`, because it needs Express and the Express adapter, which
  depend on the server package.
- The test facilitator is `x402Facilitator` with the `@x402/stellar` exact
  scheme, served over `node:http`, and is never exported.

Known failure: the sequential duplicate case fails. The gate calls the
facilitator's `/verify` before it looks the payment up in the settlement
cache, and after the first settlement the facilitator's simulation of the
same transaction fails with `Error(Auth, ExistingValue)` (the auth nonce is
spent), so the retry gets `402 invalid_exact_stellar_payload_simulation_failed`
instead of the replayed receipt. The concurrent case passes because the
second request verifies before the first lands. The fix belongs in
`packages/server` and is left for the maintainer to agree.

Details: [docs/local-network-tests.md](../local-network-tests.md).
