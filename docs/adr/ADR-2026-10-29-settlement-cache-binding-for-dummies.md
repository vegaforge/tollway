<!--
  EMBARGOED SECURITY RECORD. DO NOT PUSH THIS BRANCH OR OPEN A PUBLIC PULL REQUEST.
  Companion to ADR-2026-10-29-settlement-cache-binding.md. Keep local until the
  security advisory is published.
-->

# ADR for Dummies: One payment, one purchase

- **Status:** Accepted 2026-10-29. **Embargoed: keep local.**
- **Date:** 2026-10-29
- **Technical ADR:** [ADR-2026-10-29-settlement-cache-binding](ADR-2026-10-29-settlement-cache-binding.md)

## The idea

Tollway remembers recent payments for 30 seconds so that if an agent's
request is retried, the agent is not charged twice. Today that memory only
checks "have I seen this payment?", not "was this payment for this thing?".
So a payment made for one paid page can be shown again to open a different
paid page for free. The fix makes the memory check both, and closes two
smaller holes next to it.

## What people see

1. An agent pays for `/quotes/latest` and gets the data and a receipt.
2. Its retry of the same request still gets the same data and the same
   receipt, with no second charge. Nothing changes here.
3. If someone presents that same payment to `/quotes/history`, the service
   now refuses with a clear "already used for a different purchase" message
   instead of serving it for free.
4. If the same payment arrives twice at the same moment, it is settled once,
   and both requests get the one receipt.
5. If the memory store (for example Redis) has an outage while saving a
   receipt, the agent still gets what it paid for, and the service operator
   sees the error, instead of the service crashing.

## Important limitation

This fixes the gate's memory. It does not change how the payment network
checks payments. Whether a retry after a real on-chain settlement gets the
receipt or a "payment required" answer depends on the facilitator's
behaviour, which has not been tested live yet. That question is left open in
the technical record.

## What changes

- A remembered payment only counts for the exact page, price, currency, payee,
  and network it paid for.
- Duplicate payments that arrive together are settled once.
- A failure to save a receipt is reported, not crashed on and not hidden.
- One small version bump of `@tollway/server`.

## What does not change

- The receipt format and how receipts are signed.
- The framework adapters' code.
- Normal retries of the same request.

## Why this is handled quietly

This is a security hole in code people can copy today. It is fixed in a
private GitHub security advisory first, and announced after the fix is on
`main`, so nobody learns how to exploit it before it is closed. No package
from this repository is on npm yet, which limits who is affected.
