---
"@vegaforge/tollway-client": minor
---

Add `AgentSigner` with `createKeypairSigner` and `createSmartAccountSigner` (#205). A signer lists its x402, MPP charge and MPP channel capabilities; the x402 and MPP charge settlers take one and refuse a signer without the capability they need with `SignerCapabilityError` before any request. `signerModels` and the new `supportedModels` client option tell the router which models the agent can pay.
