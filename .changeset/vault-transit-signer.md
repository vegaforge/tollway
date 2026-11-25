---
"@vegaforge/tollway-signer-vault": minor
"@vegaforge/tollway-core": minor
---

Add `@vegaforge/tollway-signer-vault`, a `ReceiptSigner` that signs with a HashiCorp Vault Transit Ed25519 key and pins the key version, so a Vault-side rotation never changes the key behind a `keyId`. Core gains the `signer-failed` error code.
