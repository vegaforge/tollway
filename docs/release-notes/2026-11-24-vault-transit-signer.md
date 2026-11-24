---
date: 2026-11-24
feature: A receipt signer backed by a HashiCorp Vault Transit Ed25519 key
scope: feat
packages: ["@vegaforge/tollway-signer-vault", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Vault Transit receipt signer

A service can now sign receipts with a key that never leaves HashiCorp Vault. `createVaultTransitSigner` from the new `@vegaforge/tollway-signer-vault` package returns a `ReceiptSigner` the gate takes in place of `Ed25519Signer`. Receipts it signs verify with `Ed25519Verifier` and the key-set verifier, unchanged.

The signer reads the Transit key once at creation, refuses any type but `ed25519`, and pins the key version: every sign call sends `key_version`, the version is part of the `keyId`, and a signature Vault made with another version is refused. A rotation in Vault therefore never changes the key behind a `keyId`; picking it up means creating a new signer. `publicJwk()` returns the pinned version's public key for the key set.

Vault failures surface as `VaultTransitError` (code `signer-failed`) with a `kind` such as `sealed`, `permission-denied`, `key-missing` or `timeout`, plus Vault's `request_id` when it sent one. The token never appears in an error. Requests use `fetch` only, with a timeout and an optional `AbortSignal`. Against a local Vault 2.2 dev server a signature takes about 1.7 ms.

Closes #168. Pull request: #338.
