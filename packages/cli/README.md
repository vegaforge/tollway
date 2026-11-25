# @vegaforge/tollway-cli

The `tollway` command: a read-only debugging tool for Tollway and x402 paid routes.

```bash
npx @vegaforge/tollway-cli decode "<PAYMENT-REQUIRED value>"
npx @vegaforge/tollway-cli verify receipt.json --keys keys.json
npx @vegaforge/tollway-cli inspect https://api.example.com/quotes/latest
```

- `decode` names and validates any payment header value, in base64 or base64url. A `PAYMENT-SIGNATURE` is summarised unless you pass `--raw`.
- `verify` checks a signed receipt against a key-set document, a key map, or a published key set (`--jwks`).
- `inspect` sends one unpaid request and explains the 402. It follows redirects only within the same origin.

Every command takes `--json` and exits `0` (ok), `1` (a decode, validation or verification failure) or `2` (a usage error). No command takes a secret key or makes a payment.

See the "The tollway command" page of the Tollway docs for example sessions.
