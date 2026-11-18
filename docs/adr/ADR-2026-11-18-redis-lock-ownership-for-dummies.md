# ADR for Dummies: Only the process holding the lock can let go of it

- **Status:** Accepted 2026-11-18.
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-redis-lock-ownership](ADR-2026-11-18-redis-lock-ownership.md)

## The idea

When several copies of a service share Redis, they use a lock so that only one
of them submits a payment at a time. Today every copy writes the same value
into that lock, so a copy that has lost the lock can still delete someone
else's. If the payment network is slow, that can let the same payment be
submitted two or three times, and the payer can be charged more than once.
The fix gives each lock a unique ticket and only the ticket holder can remove
or extend it.

## What people see

1. An agent pays. One copy of the service takes the lock and submits the
   payment.
2. While the payment network is slow, that copy keeps extending its lock, so
   no other copy can submit the same payment.
3. When it finishes, it removes only its own lock.
4. If the copy crashes, the lock still expires by itself after 30 seconds.

## Important limitation

If the lock is lost anyway (Redis restarted, the machine froze for a long
time), Tollway now reports that loudly, but it cannot undo a duplicate the
payment network already accepted.

## What changes

- Each lock has a unique ticket, and removal and extension check it.
- Long payments keep their lock alive.
- Anyone who wrote their own Redis client wrapper must add one method.

## What does not change

- How agents pay, the receipt, and single-process deployments.
