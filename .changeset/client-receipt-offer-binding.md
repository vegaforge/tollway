---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": minor
---

`pay()` rejects a receipt that does not describe the paid offer (amount,
asset, payee, resource, network, model, settlement kind, payer and
`issuedAt`) with `ReceiptOfferMismatchError`, and refuses an offer for another
network, or for a resource other than the one requested, before paying. Adds
the `receiptMaxSkewMs` and `clock` options, `ClientSettler.payer`, and the
`receipt-offer-mismatch` and `offer-network-mismatch` error codes.

This is a behaviour change: a settler whose receipts do not match the offer
now fails.
