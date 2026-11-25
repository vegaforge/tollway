# @vegaforge/tollway-signer-vault

A Tollway `ReceiptSigner` backed by a HashiCorp Vault Transit Ed25519 key. The private key never enters the process: each signature is one request to Vault, using `fetch` only.

```ts
import { createVaultTransitSigner } from "@vegaforge/tollway-signer-vault";

const signer = await createVaultTransitSigner({
  address: "https://vault.internal:8200",
  token: process.env.VAULT_TOKEN ?? "",
  keyName: "tollway-receipts",
});
```

The key version is resolved when the signer is created and pinned on every sign call, and it is part of the `keyId` (`vault-transit:transit/tollway-receipts:v3`). A rotation in Vault never changes the key behind a `keyId` that verifiers already trust. Only Ed25519 keys are supported.

See the "Vault Transit signer" page of the Tollway docs for the Vault policy, rotation procedure and failure behaviour.
