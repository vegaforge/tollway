<!-- EMBARGOED SECURITY RECORD. Keep local; see the technical ADR. -->

# ADR for Dummies: The safety net looks at every payment, not just the last one

- **Status:** Accepted 2026-11-18. **Embargoed: keep local.**
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-reconcile-stream-integrity](ADR-2026-11-18-reconcile-stream-integrity.md)

## The idea

In channel mode, an agent sends a running total with each payment, and the
final total is paid out on chain at the end. Tollway's reconciliation checks
that what was paid out matches what was promised. Today it only looks at the
last running total. If the totals ever go down, or a total from a different
channel sneaks in, it can say "all good" when someone was underpaid. The fix
makes it check every step.

## What people see

1. A channel runs, totals go up, the channel closes, reconciliation says OK,
   as today.
2. If a total ever goes down, reconciliation now flags it.
3. If a total from another channel is mixed in, it is flagged and ignored for
   the sums.
4. If two totals claim the same position, that is flagged by name.

## Important limitation

Reconciliation still trusts the signatures on the totals. Checking those
signatures is separate work.

## What changes

- Three new kinds of warning.
- The expected payout is the highest total promised, not the last one listed.

## What does not change

- Healthy channels still reconcile cleanly, and existing warnings read the same.
