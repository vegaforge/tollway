---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-server": minor
---

Add receipt v2 with offer hash, method and expiry (#166). `receiptBodySchema` becomes a union discriminated on `version`; `receiptBodyV1Schema` is unchanged byte-for-byte, and the new `receiptBodyV2Schema` adds `offerHash` (base64url SHA-256 of the RFC 8785 canonical bytes of the offer the payer accepted), `method` (non-empty string; uppercase HTTP method by convention), and optional `expiresAt` (ISO 8601, strictly after `issuedAt`). A new exported `hashOffer(offer)` is the only way the gate and verifiers compute `offerHash`; it includes `models` (ordered), `facilitatorUrl`, `mppSessionSupported` and `quote` so two offers for the same URL and price with different routing produce distinguishable receipts. `verifyReceipt(candidate, verifier, { now? })` accepts an optional `now` in ms and rejects an expired v2 receipt with the distinct reason `"receipt expired"`; a receipt without `expiresAt` never expires. The gate issues v2 receipts by default, binding the request method into every receipt; cached v1 receipts continue to serve during a rolling deploy.
