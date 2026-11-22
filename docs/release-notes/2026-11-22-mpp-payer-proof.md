---
date: 2026-11-22
feature: MPP charge credentials prove their payer at verify time
scope: fix
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# MPP charge credentials prove their payer at verify time

The MPP charge handler's `verify` step now checks that the credential's
`source` account signed for the payment before it reports that account as the
payer. A credential that names an account it cannot sign for is rejected with
a 402 before the service policy, the settlement lock or `@stellar/mpp` see it.

`@stellar/mpp` already refused such credentials at settlement, so no payment
could be made or served in another account's name. The gap was earlier: the
gate reads the payer at verify time and the per-payer service policy acts on
it then, so a credential naming someone else's account could take a
reservation in that account's policy windows until settlement failed. A flood
of them could get that account's genuine payments refused for a while.

The check runs offline and mirrors what the network will demand:

- Pull mode (`type: "transaction"`): the transaction is one SEP-41 `transfer`
  whose `from` is the source, signed by the source either as the transaction's
  source account or through a Soroban address authorization entry. These are
  the two shapes the `@stellar/mpp` charge client produces (unsponsored and
  sponsored).
- Push mode (`type: "signedHash"`): the source key's signature over
  `{challenge.id}:{hash}`, the binding `@stellar/mpp` checks.
- Unsigned `type: "hash"` credentials are refused; `@stellar/mpp` 0.7 refuses
  them too.

`@vegaforge/tollway-server` now declares `@stellar/stellar-sdk` 16.4.1, the
version `@stellar/mpp` 0.7.1 already brought in, to decode the transaction.
