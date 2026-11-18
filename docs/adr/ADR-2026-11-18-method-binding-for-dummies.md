<!-- EMBARGOED SECURITY RECORD. Keep local; see the technical ADR. -->

# ADR for Dummies: Paying to read does not let you write

- **Status:** Accepted 2026-11-18. **Embargoed: keep local.**
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-method-binding](ADR-2026-11-18-method-binding.md)

## The idea

A web address can do different things depending on how you call it: read a
report, or create one. Tollway remembers a payment so a retry is not charged
twice, but it does not remember which kind of call the payment was for. So one
payment to read can be reused to create, for free. The fix makes Tollway
remember the kind of call too.

## What people see

1. An agent pays to read `/report` and gets it.
2. A retry of that same read still works, with no second charge.
3. If someone reuses that payment to create a report at the same address, the
   service now answers "already used for a different purchase".

## Important limitation

The receipt itself does not yet say which kind of call was paid for. That is
planned separately as a new receipt version.

## What changes

- Payments are tied to the kind of call as well as the address and price.
- People who wrote their own storage for remembered payments store one extra
  field.

## What does not change

- How agents pay, what a receipt looks like, and what an honest retry gets.
