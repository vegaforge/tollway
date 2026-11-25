---
date: 2026-11-24
feature: An agent-side settler that pays MPP charge routes on Stellar
scope: feat
packages: ["@vegaforge/tollway-client"]
scenario-impact: none
---

# MPP charge settler for the client

An agent can now pay an `mpp-charge` route. `createMppChargeSettler` from
`@vegaforge/tollway-client` is a `ClientSettler`, so it plugs into
`createClient` next to `createX402Settler`. Before it signs anything, it checks
the service's Stellar charge challenge against the offer the policy approved:
the amount, the recipient, the token contract and the network must all match,
and the challenge must not have expired. A mismatch rejects with a
`TollwayError` that names the field, and nothing is signed.

It requests the resource, reads the `WWW-Authenticate: Payment` challenge,
builds the credential with `@stellar/mpp/charge/client` through `mppx`'s
`createCredential`, and retries with `Authorization: Payment`. The Tollway
receipt comes back in `TOLLWAY-RECEIPT` and must describe an `mpp-charge`
payment of the offer's amount to the offer's payee on the offer's network.
When the service also sends MPP's `Payment-Receipt`, its `reference` must equal
the receipt's transaction hash.

`pull` mode, the default, has the service submit the signed transaction. In
`push` mode the agent submits it and pays the network fee, so its account also
needs XLM. Offer assets may be a contract address, `CODE:ISSUER` or `native`;
the last two map to their Stellar Asset Contract. Tollway network ids map
explicitly to `stellar:testnet` and `stellar:pubnet`. The secret key goes only
to `@stellar/mpp`, and `globalThis.fetch` is never patched.

The client package now depends on `@stellar/mpp` 0.7.1, `mppx` 0.8.19,
`@stellar/stellar-sdk` 16.4.1 and `zod`, the same versions the server package
already uses. An opt-in testnet test pays a live route
(`mpp-charge-settler.integration.test.ts`).

Pull request: #334.
