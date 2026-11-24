---
date: 2026-11-24
feature: The client rejects a receipt that does not describe the payment it made
scope: fix
packages: ["@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Receipts bound to the paid offer on the agent side

`createClient().pay()` used to trust any receipt whose signature verified. A
buggy or hostile service could charge the offer price and hand back a
correctly signed receipt for a different, cheaper or unrelated payment, and
the agent's budgets and receipt history would believe it.

`pay()` now checks the receipt against the paid offer before it stores the
receipt, records spend on the policy engine or emits a `payment` event. The
`amount`, `asset`, `payee`, `resource`, `network` and `model` must match the
offer, the settlement reference must fit the model, the payer must be the
settler's own address when the settler reports one, and `issuedAt` must be
within five minutes of the client clock (`receiptMaxSkewMs`). A mismatch
rejects with `ReceiptOfferMismatchError`, code `receipt-offer-mismatch`, naming
the first field that differs, and the `error` event fires instead of
`payment`. The checks run with or without a verifier.

Before paying, an offer for another network than the client's is refused with
`OfferNetworkMismatchError` (code `offer-network-mismatch`), and the offer's
resource must have the same path and query as the URL the agent requested.

The x402 settler now exposes `payer`, its signer's public address. Two error
codes are added to `@vegaforge/tollway-core`.

Behaviour change: a settler that returned receipts which do not match the
offer, including a receipt for another model than the one `pay()` chose, now
fails where it used to succeed.

Closes #202. Pull request: #330.
