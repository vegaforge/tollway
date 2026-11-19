# Plan: Next.js 16 proxy paywall (2026-11-18)

- **ADR:** [ADR-2026-11-18-next16-proxy](../adr/ADR-2026-11-18-next16-proxy.md)
- **Issue:** #260

## Boundaries

Change `packages/adapter-next`, its version-matrix tests/configuration, README, and web getting-started docs. Keep payment logic in server and leave other adapters untouched.

## Interfaces

Add a proxy configuration helper mapping path patterns to `Gate` instances, plus `getProxyReceipt(request)` that reads and schema-validates the proxy-owned receipt header. Final names and return type must match the installed Next 16 source API inspected after approval.

## State changes

No persistent state. Receipt forwarding exists only on the request crossing from the Next proxy to its matched route handler.

## Test strategy

Test `withPaywall` under Next 14, 15, and 16. For the proxy, test matched/unmatched routes, 402 challenge, rejected payment, successful forwarding, a client-supplied forged receipt header, receipt schema validation, runtime support guard, and `PAYMENT-RESPONSE` preservation.

## Steps

1. Inspect installed Next 16 source and declarations for proxy header forwarding and runtime; record exact supported shape in tests.
2. Widen the optional peer range and establish a 14/15/16 test matrix.
3. Add proxy request matching, caller-header stripping, gate invocation, and settlement receipt forwarding.
4. Add the validating route helper and adversarial tests.
5. Update README and docs, then add a changeset and release note.
6. Run the full preflight and manually exercise a Next 16 proxy route.
