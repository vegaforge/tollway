---
date: 2026-11-24
feature: A read-only tollway command to decode headers, verify receipts and inspect 402s
scope: feat
packages: ["@vegaforge/tollway-cli"]
scenario-impact: none
---

# The tollway command

`@vegaforge/tollway-cli` adds a `tollway` binary for debugging paid routes without writing a script.

- `tollway decode <value | ->` detects base64 or base64url, decodes the value, names the shape (Tollway `SignedReceipt`, x402 `PaymentRequired`, `PaymentPayload` or `SettleResponse`, or a Tollway offer) and validates it with the matching schema. A `PAYMENT-SIGNATURE` is summarised as scheme, network, amount, asset, payee and payer; its signed envelope is printed only with `--raw`.
- `tollway verify <file | ->` verifies a receipt against `--keys <file>` (a key-set document or a key map) or `--jwks <url>`, and prints the reason when it fails.
- `tollway inspect <url>` sends one unpaid request and explains the 402. It refuses redirects to another origin, has a timeout, and caps the body it reads.

Every command takes `--json`, writes errors to stderr and exits `0`, `1` (decode, validation or verification failure) or `2` (usage error). Nothing in it takes a secret key or pays. The binary starts in well under a second because it does not load `@vegaforge/tollway-server`; the Stellar SDK is imported only when a `PAYMENT-SIGNATURE` is summarised.

Closes #170. Pull request: #338.
