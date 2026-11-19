# ADR for Dummies: Next.js 16 proxy paywall

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-next16-proxy](ADR-2026-11-18-next16-proxy.md)

## The idea

Allow Next.js 16 services to put one payment check in `proxy.ts` for a group of paid routes. When payment succeeds, the proxy passes its verified receipt to the route handler in a way that the caller cannot fake.

## What people see

1. The operator maps URL paths to their existing Tollway gates in one proxy file.
2. Unpaid requests receive the normal payment challenge, and rejected payments receive the normal error.
3. A paid request continues to the route handler, which can read a schema-checked receipt with a helper.

## Important limitation

This only works when requests to the protected routes pass through the configured Next proxy. Tollway still relies on the service's signer, facilitator, and framework runtime; it does not custody funds.

## What changes

The Next adapter supports the Next 16 peer range, tests supported versions, and adds a proxy helper plus documentation.

## What does not change

Payment verification and settlement stay in the existing Tollway server gate. The other three adapters are unchanged.
