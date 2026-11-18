# @vegaforge/tollway-core

## 0.1.0

### Minor Changes

- 42fc74c: Receipt verification is strict. A receipt with any field the signature does not cover, in the body, the signature or the envelope, now fails `verifyReceipt`, and a valid result carries the parsed receipt as `result.receipt`. `@vegaforge/tollway-client` returns that parsed receipt from `pay()` instead of the settler's object, and rejects a malformed receipt with `TollwayError` code `invalid-receipt` even when no verifier is configured. Breaking: the receipt schemas reject unknown keys.
