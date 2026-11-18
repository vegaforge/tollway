# ADR for Dummies: A checked receipt has nothing added to it

- **Status:** Accepted 2026-11-18.
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-strict-receipt-verification](ADR-2026-11-18-strict-receipt-verification.md)

## The idea

A Tollway receipt is signed, so nobody can change the amount or who was paid.
But today someone can add new lines to a receipt, such as "refunded: yes", and
the check still says the receipt is genuine, because it ignores lines it does
not recognise. The fix makes the check refuse any receipt with lines that were
not signed, and hands back only the signed version.

## What people see

1. A service issues a receipt. The agent checks it and it passes, as today.
2. If someone adds an unsigned line to that receipt, the check now fails.
3. The agent's code always gets back the receipt exactly as it was signed.

## Important limitation

This protects the receipt's contents. It does not say whether the payment
actually landed on chain; that is reconciliation's job.

## What changes

- Receipts with extra, unsigned information are rejected.
- The check returns the clean, signed receipt.

## What does not change

- How receipts are signed, and every genuine receipt already issued.
