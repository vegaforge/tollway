---
date: 2026-11-21
feature: A retried x402 payment is answered from the cache before it is verified again
scope: fix
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# A retried x402 payment gets its receipt again

A client that sent the same `PAYMENT-SIGNATURE` twice in a row got a 402 on
the second request instead of its receipt. The gate verified the payment
before looking in its settlement cache, and once a payment has settled on
chain its authorization nonce is spent, so the facilitator rejects it.

The gate now derives the payment's idempotency key first, through the new
optional `FacilitatorClient.idempotencyKey`, and answers a settled payment
from the cache without verifying it again. The receipt is still only returned
for the offer and HTTP method it was paid for. Both built-in facilitators
implement the method. A custom facilitator that does not keeps the old
behaviour. Closes #284.
