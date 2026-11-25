---
date: 2026-11-24
feature: Paid MCP tools, settled after the tool succeeds
scope: feat
packages: ["@vegaforge/tollway-mcp", "@vegaforge/tollway-server"]
scenario-impact: none
---

# Paid MCP tools

A service can now charge for MCP tool calls with the same configuration,
facilitator, settlement cache and signed receipt it uses for HTTP routes
(#206).

## What changed

- **New package `@vegaforge/tollway-mcp`.** `paidTool(config, deps)(handler)`
  wraps an MCP tool handler and speaks the x402 MCP transport: an unpaid call
  gets `isError: true` with `PaymentRequired`; a paid call carries its
  `PaymentPayload` in `_meta["x402/payment"]`; a paid result carries the x402
  `SettleResponse` in `_meta["x402/payment-response"]` and the signed Tollway
  receipt in `_meta["tollway/receipt"]`.
- **Settle after success.** The payment is verified before the tool runs and
  settled only after it succeeds. A tool that throws or returns
  `isError: true` is not charged, and the payment stays usable.
- **`createPaidCall` in `@vegaforge/tollway-server`.** A transport-agnostic
  entry point for a paid operation that is not an HTTP request. It builds the
  same settlement context as `createPaywall` and settles through the same
  path, so replay protection, settlement locks, receipt signing and offer
  binding have one implementation. The path gains an optional `beforeSettle`
  hook; the HTTP gate passes none, so its behaviour is unchanged.
- **Replays.** The same payment again gets the cached receipt without a second
  settlement, and the tool runs again for the retry, as a replayed payment
  re-serves an HTTP route. Two concurrent calls with one payment settle once.

`@x402/mcp` was considered and not composed: it verifies and settles through
an `x402ResourceServer` with no settlement cache, which would give a payment
two sources of truth for idempotency. The wire format matches it.

Docs: `apps/web/src/content/docs/mcp.mdx`. Example: `examples/paid-mcp-tool`.

## Verification

`packages/mcp` tests run a real `@modelcontextprotocol/sdk` client and server
over an in-memory transport with the mock facilitator: unpaid, paid, replayed,
concurrent, tool error, tool throw, settlement failure after the tool ran,
invalid payments, cache write failure, and a receipt cached for another tool.
`packages/server` tests cover `createPaidCall` directly, and the existing gate
and adapter suites pass unchanged.
