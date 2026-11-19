# ADR for Dummies: Threat model and abuse-case verification

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-threat-model-abuse-cases](ADR-2026-11-18-threat-model-abuse-cases.md)

## The idea

Write down what Tollway protects, where it relies on other systems, and how someone might try to misuse a payment or receipt. For every attack we say Tollway already blocks, add a test that tries it.

## What people see

1. Operators and maintainers can read one document to see the payment flow, the risks, and which defenses have test evidence.
2. Contributors can see which risks are still open and which issue owns them.
3. CI checks that every risk marked defended is named by a test, so documentation cannot quietly claim more than the tests cover.

## Important limitation

The document and tests do not make Tollway responsible for a facilitator's correctness, wallet security, or custody of funds. Tollway does not custody funds. If test work finds a new security defect, it is reported privately and not described in public documentation.

## What changes

The repository gains a detailed threat model, focused attack tests, and a consistency check in CI. The security and design documents link to it.

## What does not change

This issue does not change how a payment is verified or settled. A discovered defect is handled as a separate security fix.
